require("./env");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg");
const {
  getQueuedJob,
  updateJobStatus,
  completeJob,
  failJob,
  getExpiredJobs,
  deleteJob,
} = require("./db");

const JOBS_DIR = path.join(__dirname, "..", "jobs");
const REPLAY_HTML = path.join(__dirname, "replay.html");
const POLL_INTERVAL = 2000; // 2 seconds
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

async function processJob(job) {
  const jobDir = path.join(JOBS_DIR, job.id);
  const inputPath = path.join(jobDir, "input.json");
  const rawVideoPath = path.join(jobDir, "raw.webm");
  const outputPath = path.join(jobDir, "output.mp4");

  console.log(`Processing job ${job.id} (${job.width}x${job.height} @ ${job.fps}fps, speed ${job.speed}x)`);
  updateJobStatus.run("processing", 10, job.id);

  let browser;
  try {
    // Read the events JSON
    const eventsJson = fs.readFileSync(inputPath, "utf-8");

    // Validate it's parseable JSON
    let events;
    try {
      events = JSON.parse(eventsJson);
      // Handle case where events are wrapped in an object
      if (events && !Array.isArray(events) && events.events) {
        events = events.events;
      }
      if (!Array.isArray(events) || events.length === 0) {
        throw new Error("JSON must contain a non-empty array of rrweb events");
      }
    } catch (parseErr) {
      throw new Error(`Invalid rrweb JSON: ${parseErr.message}`);
    }

    updateJobStatus.run("processing", 20, job.id);

    // Launch headless Chromium
    const launchOptions = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        `--window-size=${job.width},${job.height}`,
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.setViewport({ width: job.width, height: job.height });

    updateJobStatus.run("processing", 30, job.id);

    // Read replay HTML template
    const replayHtml = fs.readFileSync(REPLAY_HTML, "utf-8");

    // Inject events and config into the HTML
    const injectedHtml = replayHtml
      .replace("__EVENTS_PLACEHOLDER__", JSON.stringify(events))
      .replace("__WIDTH__", String(job.width))
      .replace("__HEIGHT__", String(job.height))
      .replace("__SPEED__", String(job.speed));

    // Write the injected HTML to a temp file in the job directory
    const tempHtmlPath = path.join(jobDir, "replay.html");
    fs.writeFileSync(tempHtmlPath, injectedHtml);

    updateJobStatus.run("processing", 40, job.id);

    // Start screencast via CDP session
    const client = await page.createCDPSession();

    const frames = [];
    client.on("Page.screencastFrame", async (frame) => {
      frames.push(Buffer.from(frame.data, "base64"));
      try {
        await client.send("Page.screencastFrameAck", {
          sessionId: frame.sessionId,
        });
      } catch {
        // Session may already be closed
      }
    });

    // Navigate to the replay page
    await page.goto(`file://${tempHtmlPath}`, { waitUntil: "networkidle0" });

    updateJobStatus.run("processing", 50, job.id);

    // Start screencast
    await client.send("Page.startScreencast", {
      format: "png",
      quality: 100,
      maxWidth: job.width,
      maxHeight: job.height,
      everyNthFrame: 1,
    });

    // Wait for replay to finish (look for .replay-done element)
    // Calculate a reasonable timeout based on events timespan
    const firstTimestamp = events[0].timestamp;
    const lastTimestamp = events[events.length - 1].timestamp;
    const replayDuration = (lastTimestamp - firstTimestamp) / job.speed;
    const timeout = Math.max(replayDuration + 30000, 60000); // At least 60s

    try {
      await page.waitForSelector(".replay-done", { timeout });
    } catch {
      console.warn(`Job ${job.id}: replay-done not detected within timeout, proceeding with captured frames`);
    }

    // Give a small buffer for final frames
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Stop screencast
    try {
      await client.send("Page.stopScreencast");
    } catch {
      // May already be stopped
    }

    updateJobStatus.run("processing", 70, job.id);

    console.log(`Job ${job.id}: Captured ${frames.length} frames`);

    if (frames.length === 0) {
      throw new Error("No frames were captured during replay");
    }

    // Write frames to disk as PNGs for ffmpeg input
    const framesDir = path.join(jobDir, "frames");
    fs.mkdirSync(framesDir, { recursive: true });

    for (let i = 0; i < frames.length; i++) {
      const framePath = path.join(framesDir, `frame_${String(i).padStart(6, "0")}.png`);
      fs.writeFileSync(framePath, frames[i]);
    }

    updateJobStatus.run("processing", 80, job.id);

    // Use ffmpeg to encode frames to MP4
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(framesDir, "frame_%06d.png"))
        .inputFPS(job.fps)
        .videoCodec("libx264")
        .outputOptions([
          "-pix_fmt yuv420p",
          `-s ${job.width}x${job.height}`,
          "-preset fast",
          "-crf 23",
          "-movflags +faststart",
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    updateJobStatus.run("processing", 95, job.id);

    // Get output file size
    const stats = fs.statSync(outputPath);

    // Cleanup temp files
    fs.rmSync(framesDir, { recursive: true, force: true });
    try {
      fs.unlinkSync(tempHtmlPath);
    } catch {
      // ignore
    }

    // Mark job as complete
    completeJob.run(stats.size, job.id);
    console.log(`Job ${job.id}: Complete (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err.message);
    failJob.run(err.message, job.id);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

function cleanupExpiredJobs() {
  const expired = getExpiredJobs.all();
  for (const job of expired) {
    console.log(`Cleaning up expired job ${job.id}`);
    const jobDir = path.join(JOBS_DIR, job.id);
    fs.rmSync(jobDir, { recursive: true, force: true });
    deleteJob.run(job.id);
  }
  if (expired.length > 0) {
    console.log(`Cleaned up ${expired.length} expired job(s)`);
  }
}

async function pollLoop() {
  while (true) {
    try {
      const job = getQueuedJob.get();
      if (job) {
        await processJob(job);
      }
    } catch (err) {
      console.error("Worker error:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// Start the worker
console.log("Worker started, polling for jobs...");

// Run cleanup on start and then every hour
cleanupExpiredJobs();
setInterval(cleanupExpiredJobs, CLEANUP_INTERVAL);

pollLoop();
