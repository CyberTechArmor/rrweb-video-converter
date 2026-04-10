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
const REPLAY_HTML_PATH = path.join(__dirname, "replay.html");
const POLL_INTERVAL = 2000; // 2 seconds
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

// ── Locate and cache rrweb assets at startup ──────────────────────
function resolveRrwebAssets() {
  const root = path.join(__dirname, "..");
  const rrwebDist = path.join(root, "node_modules", "rrweb", "dist");

  if (!fs.existsSync(rrwebDist)) {
    throw new Error(
      "rrweb not found in node_modules. Run `npm install` in the project root."
    );
  }

  // Prefer an IIFE/UMD build (has a global). rrweb ships:
  //   dist/rrweb.js        — UMD with global `rrweb`
  //   dist/rrweb.min.js    — minified UMD
  //   dist/rrweb.umd.cjs   — newer versions
  const jsCandidates = [
    "rrweb.min.js",
    "rrweb.js",
    "rrweb.umd.cjs",
    "index.umd.js",
    "rrweb-all.js",
  ];
  const cssCandidates = ["rrweb.css", "style.css", "rrweb.min.css"];

  let jsPath = null;
  let cssPath = null;

  for (const name of jsCandidates) {
    const p = path.join(rrwebDist, name);
    if (fs.existsSync(p)) {
      jsPath = p;
      break;
    }
  }
  for (const name of cssCandidates) {
    const p = path.join(rrwebDist, name);
    if (fs.existsSync(p)) {
      cssPath = p;
      break;
    }
  }

  // Fallback: scan the directory
  if (!jsPath) {
    const files = fs.readdirSync(rrwebDist);
    const jsFile = files.find(
      (f) =>
        (f === "rrweb.js" ||
          f === "rrweb.min.js" ||
          f.endsWith(".umd.cjs") ||
          f.endsWith(".umd.js")) &&
        !f.includes("esm")
    );
    if (jsFile) jsPath = path.join(rrwebDist, jsFile);
    const cssFile = files.find((f) => f.endsWith(".css"));
    if (cssFile && !cssPath) cssPath = path.join(rrwebDist, cssFile);
  }

  if (!jsPath) {
    throw new Error(
      `Could not find rrweb UMD build in ${rrwebDist}. ` +
        `Contents: ${fs.readdirSync(rrwebDist).join(", ")}`
    );
  }

  console.log(`Using rrweb JS:  ${jsPath}`);
  console.log(`Using rrweb CSS: ${cssPath || "(none found)"}`);

  return {
    js: fs.readFileSync(jsPath, "utf-8"),
    css: cssPath ? fs.readFileSync(cssPath, "utf-8") : "",
  };
}

let RRWEB_ASSETS;
try {
  RRWEB_ASSETS = resolveRrwebAssets();
} catch (err) {
  console.error("[worker] Failed to load rrweb assets:", err.message);
  // Don't exit — let jobs fail with a clear error message
  RRWEB_ASSETS = { js: "", css: "" };
}

const REPLAY_HTML_TEMPLATE = fs.readFileSync(REPLAY_HTML_PATH, "utf-8");

// ── Helpers ────────────────────────────────────────────────────────
function buildReplayHtml(events, job) {
  // Use function form of String.prototype.replace to avoid issues where the
  // rrweb JS/CSS content contains special replacement patterns (e.g. "$&")
  // which String.replace would otherwise interpret.
  return REPLAY_HTML_TEMPLATE
    .replace(/\/\* __RRWEB_CSS__ \*\//, () => RRWEB_ASSETS.css)
    .replace(/\/\/ __RRWEB_JS__/, () => RRWEB_ASSETS.js)
    .replace("__EVENTS_PLACEHOLDER__", () => JSON.stringify(events))
    .replace(/__WIDTH__/g, String(job.width))
    .replace(/__HEIGHT__/g, String(job.height))
    .replace("__SPEED__", String(job.speed));
}

function parseEventsJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
  if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.events)) {
    parsed = parsed.events;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("JSON must contain a non-empty array of rrweb events");
  }
  return parsed;
}

// ── Main job processor ────────────────────────────────────────────
async function processJob(job) {
  const jobDir = path.join(JOBS_DIR, job.id);
  const inputPath = path.join(jobDir, "input.json");
  const outputPath = path.join(jobDir, "output.mp4");
  const tempHtmlPath = path.join(jobDir, "replay.html");
  const framesDir = path.join(jobDir, "frames");

  const logPrefix = `[job ${job.id}]`;
  console.log(`${logPrefix} Start (${job.width}x${job.height} @ ${job.fps}fps, speed ${job.speed}x)`);
  updateJobStatus.run("processing", 5, job.id);

  if (!RRWEB_ASSETS.js) {
    failJob.run(
      "rrweb library not installed. Run `npm install` in the project root.",
      job.id
    );
    return;
  }

  let browser;
  try {
    // 1. Parse JSON
    console.log(`${logPrefix} Reading events JSON...`);
    const events = parseEventsJson(fs.readFileSync(inputPath, "utf-8"));
    console.log(`${logPrefix} Loaded ${events.length} events`);
    updateJobStatus.run("processing", 10, job.id);

    // 2. Build the replay HTML with rrweb inlined
    console.log(`${logPrefix} Building replay HTML...`);
    const html = buildReplayHtml(events, job);
    fs.writeFileSync(tempHtmlPath, html);
    updateJobStatus.run("processing", 15, job.id);

    // 3. Launch Chromium
    console.log(`${logPrefix} Launching Chromium...`);
    const launchOptions = {
      headless: true,
      protocolTimeout: 300000, // 5 minutes for long ops
      timeout: 60000, // 60s launch timeout
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--hide-scrollbars",
        "--mute-audio",
        `--window-size=${job.width},${job.height}`,
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(launchOptions);
    console.log(`${logPrefix} Chromium launched`);
    updateJobStatus.run("processing", 25, job.id);

    const page = await browser.newPage();
    await page.setViewport({
      width: job.width,
      height: job.height,
      deviceScaleFactor: 1,
    });

    // Pipe page console to worker logs for debugging
    page.on("console", (msg) => {
      console.log(`${logPrefix} [page] ${msg.type()}: ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.error(`${logPrefix} [page error] ${err.message}`);
    });

    updateJobStatus.run("processing", 30, job.id);

    // 4. Navigate — use domcontentloaded (not networkidle0) to avoid hanging
    console.log(`${logPrefix} Loading replay page...`);
    await page.goto(`file://${tempHtmlPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    console.log(`${logPrefix} Replay page loaded`);

    // Wait for rrweb to have initialized
    try {
      await page.waitForFunction(
        "window.__REPLAY_READY__ === true || window.__REPLAY_ERROR__",
        { timeout: 30000 }
      );
    } catch {
      throw new Error("rrweb Replayer failed to initialize within 30 seconds");
    }

    const replayError = await page.evaluate(
      () => window.__REPLAY_ERROR__ || null
    );
    if (replayError) {
      throw new Error(`rrweb Replayer error: ${replayError}`);
    }

    updateJobStatus.run("processing", 40, job.id);

    // 5. Start CDP screencast
    console.log(`${logPrefix} Starting screencast...`);
    const client = await page.createCDPSession();

    const frames = [];
    let frameCounter = 0;

    client.on("Page.screencastFrame", async (frame) => {
      frames.push(Buffer.from(frame.data, "base64"));
      frameCounter++;
      try {
        await client.send("Page.screencastFrameAck", {
          sessionId: frame.sessionId,
        });
      } catch {
        // session closed
      }
    });

    await client.send("Page.startScreencast", {
      format: "png",
      quality: 100,
      maxWidth: job.width,
      maxHeight: job.height,
      everyNthFrame: 1,
    });

    updateJobStatus.run("processing", 50, job.id);

    // 6. Calculate replay duration and wait for finish
    const firstTs = events[0].timestamp || 0;
    const lastTs = events[events.length - 1].timestamp || 0;
    const rawDurationMs = Math.max(lastTs - firstTs, 1000);
    const expectedDurationMs = rawDurationMs / job.speed;
    const waitTimeout = Math.min(
      Math.max(expectedDurationMs + 30000, 60000),
      30 * 60 * 1000 // cap at 30 minutes
    );

    console.log(
      `${logPrefix} Replay duration ~${Math.round(
        expectedDurationMs / 1000
      )}s, waiting up to ${Math.round(waitTimeout / 1000)}s`
    );

    // Periodic progress updates during capture
    const captureStart = Date.now();
    const progressTimer = setInterval(() => {
      const elapsed = Date.now() - captureStart;
      const pct = Math.min(
        50 + Math.floor((elapsed / expectedDurationMs) * 25),
        74
      );
      try {
        updateJobStatus.run("processing", pct, job.id);
      } catch {
        // ignore
      }
    }, 1000);

    let replayFinished = false;
    try {
      await page.waitForFunction("window.__REPLAY_DONE__ === true", {
        timeout: waitTimeout,
        polling: 500,
      });
      replayFinished = true;
      console.log(`${logPrefix} Replay finished naturally`);
    } catch {
      console.warn(
        `${logPrefix} Replay did not signal done within timeout, stopping capture`
      );
    }

    clearInterval(progressTimer);

    // Give a small buffer for trailing frames
    await new Promise((r) => setTimeout(r, 1500));

    // Stop screencast
    try {
      await client.send("Page.stopScreencast");
    } catch {
      // already stopped
    }

    console.log(
      `${logPrefix} Captured ${frames.length} frames (finished=${replayFinished})`
    );
    updateJobStatus.run("processing", 75, job.id);

    if (frames.length === 0) {
      throw new Error("No frames were captured during replay");
    }

    // 7. Write frames as PNGs for ffmpeg input
    fs.mkdirSync(framesDir, { recursive: true });
    for (let i = 0; i < frames.length; i++) {
      fs.writeFileSync(
        path.join(framesDir, `frame_${String(i).padStart(6, "0")}.png`),
        frames[i]
      );
    }
    console.log(`${logPrefix} Wrote ${frames.length} frames to disk`);
    updateJobStatus.run("processing", 85, job.id);

    // 8. Encode with ffmpeg
    console.log(`${logPrefix} Encoding with ffmpeg...`);
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
        .on("start", (cmd) => console.log(`${logPrefix} ffmpeg: ${cmd}`))
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    updateJobStatus.run("processing", 95, job.id);

    // 9. Cleanup temp files
    const stats = fs.statSync(outputPath);
    fs.rmSync(framesDir, { recursive: true, force: true });
    try {
      fs.unlinkSync(tempHtmlPath);
    } catch {
      // ignore
    }

    completeJob.run(stats.size, job.id);
    console.log(
      `${logPrefix} Complete — ${(stats.size / 1024 / 1024).toFixed(2)} MB`
    );
  } catch (err) {
    console.error(`${logPrefix} FAILED:`, err);
    failJob.run(err.message || String(err), job.id);
    // Best-effort cleanup of partial artifacts
    try {
      fs.rmSync(framesDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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

// Start
console.log("Worker started, polling for jobs...");
cleanupExpiredJobs();
setInterval(cleanupExpiredJobs, CLEANUP_INTERVAL);
pollLoop();
