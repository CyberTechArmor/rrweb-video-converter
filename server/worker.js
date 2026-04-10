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

// ── Locate rrweb UMD assets and copy them to a shared location ────
// We copy them to jobs/.assets/ and reference via absolute file:// URLs
// instead of inlining into the HTML, because:
//   1) rrweb bundles can contain literal "</script>" strings that
//      prematurely close the enclosing <script> tag when inlined.
//   2) Some rrweb versions ship ESM as .js, which fails silently in
//      a classic <script> tag.
// Loading via <script src> sidesteps both issues and avoids any
// HTML-escaping concerns.
function isUmdBundle(content) {
  // Reject ES modules — top-level import/export statements throw
  // SyntaxError in a classic <script> tag. Anything else (UMD, IIFE,
  // plain script) is fine to load via a <script src> tag.
  const head = content.slice(0, 8192);
  const lines = head.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }
    if (/^(import|export)[\s{(*]/.test(trimmed)) {
      return false;
    }
    // Only inspect first few non-comment lines
    break;
  }
  return true;
}

function resolveRrwebAssetPaths() {
  const root = path.join(__dirname, "..");
  const rrwebDist = path.join(root, "node_modules", "rrweb", "dist");

  if (!fs.existsSync(rrwebDist)) {
    throw new Error(
      "rrweb not found in node_modules. Run `npm install` in the project root."
    );
  }

  const allFiles = fs.readdirSync(rrwebDist);
  console.log(`rrweb dist contents: ${allFiles.join(", ")}`);

  // Preferred UMD filenames in order
  const jsCandidates = [
    "rrweb.min.js",
    "rrweb.js",
    "rrweb-all.min.js",
    "rrweb-all.js",
    "rrweb.umd.cjs",
    "rrweb.umd.js",
  ];
  const cssCandidates = ["rrweb.min.css", "rrweb.css", "style.css"];

  let jsPath = null;
  for (const name of jsCandidates) {
    const p = path.join(rrwebDist, name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      if (isUmdBundle(content)) {
        jsPath = p;
        break;
      } else {
        console.warn(
          `${name} exists but looks like an ES module, skipping`
        );
      }
    }
  }

  let cssPath = null;
  for (const name of cssCandidates) {
    const p = path.join(rrwebDist, name);
    if (fs.existsSync(p)) {
      cssPath = p;
      break;
    }
  }

  if (!jsPath) {
    throw new Error(
      `Could not find a UMD rrweb build in ${rrwebDist}.\n` +
        `Contents: ${allFiles.join(", ")}\n` +
        `Pin rrweb to ^1.1.3 in package.json — it ships dist/rrweb.min.js as a UMD build.`
    );
  }

  return { jsPath, cssPath };
}

// At startup: read rrweb assets into memory. We'll inline them into
// the replay HTML rather than referencing via file:// URLs, which
// Chromium treats as cross-origin even with --allow-file-access-from-files
// in headless mode.
let RRWEB_JS_CONTENT = "";
let RRWEB_CSS_CONTENT = "";
let RRWEB_AVAILABLE = false;

try {
  const { jsPath, cssPath } = resolveRrwebAssetPaths();
  RRWEB_JS_CONTENT = fs.readFileSync(jsPath, "utf-8");
  console.log(`rrweb JS:  ${jsPath} (${RRWEB_JS_CONTENT.length} bytes)`);
  if (cssPath) {
    RRWEB_CSS_CONTENT = fs.readFileSync(cssPath, "utf-8");
    console.log(`rrweb CSS: ${cssPath} (${RRWEB_CSS_CONTENT.length} bytes)`);
  } else {
    console.log(`rrweb CSS: (none found)`);
  }
  RRWEB_AVAILABLE = true;
} catch (err) {
  console.error("[worker] Failed to prepare rrweb assets:", err.message);
  // Don't exit — let jobs fail with a clear error message instead
}

const REPLAY_HTML_TEMPLATE = fs.readFileSync(REPLAY_HTML_PATH, "utf-8");

// ── Helpers ────────────────────────────────────────────────────────

// Prevent premature </script>/</style> from terminating the enclosing
// tag when JS/CSS content is inlined into HTML.
function escapeForHtmlEmbed(content) {
  return content
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<\/style/gi, "<\\/style");
}

function buildReplayHtml(job) {
  // Use function form of .replace so '$' sequences in the replacement
  // values aren't interpreted as back-references.
  return REPLAY_HTML_TEMPLATE
    .replace("/* __RRWEB_CSS__ */", () => escapeForHtmlEmbed(RRWEB_CSS_CONTENT))
    .replace("/* __RRWEB_JS__ */", () => escapeForHtmlEmbed(RRWEB_JS_CONTENT))
    .replace(/__WIDTH__/g, String(job.width))
    .replace(/__HEIGHT__/g, String(job.height));
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

  if (!RRWEB_AVAILABLE) {
    failJob.run(
      "rrweb UMD bundle not available. Pin rrweb to ^1.1.3 and run `npm install`.",
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
    const html = buildReplayHtml(job);
    // Write to disk for post-mortem debugging
    fs.writeFileSync(tempHtmlPath, html);
    console.log(`${logPrefix} HTML size: ${html.length} bytes`);
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
        "--disable-web-security",
        "--allow-file-access-from-files",
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
      console.error(
        `${logPrefix} [page error] ${err.message}${
          err.stack ? "\n" + err.stack : ""
        }`
      );
    });
    page.on("requestfailed", (req) => {
      console.warn(
        `${logPrefix} [request failed] ${req.url()} — ${req.failure()?.errorText}`
      );
    });

    updateJobStatus.run("processing", 30, job.id);

    // 4a. Force the page to look "visible" so requestAnimationFrame
    //     isn't throttled to 1Hz in headless mode (rrweb's Replayer
    //     uses rAF internally to drive playback).
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      Object.defineProperty(document, "webkitHidden", {
        configurable: true,
        get: () => false,
      });
      Object.defineProperty(document, "webkitVisibilityState", {
        configurable: true,
        get: () => "visible",
      });
    });

    // Tell Chromium to emulate a focused, visible page. Belt-and-
    // suspenders alongside the property overrides above.
    try {
      const tmpClient = await page.target().createCDPSession();
      await tmpClient.send("Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
      await tmpClient.detach();
    } catch (e) {
      console.warn(
        `${logPrefix} setFocusEmulationEnabled unavailable: ${e.message}`
      );
    }

    updateJobStatus.run("processing", 32, job.id);

    // 4b. Inject events via CDP (not through HTML string substitution) so
    //     event content can't break HTML/JS parsing. evaluateOnNewDocument
    //     runs before any page script, so the init script will see the
    //     globals by the time it executes.
    console.log(`${logPrefix} Injecting events into page context...`);
    await page.evaluateOnNewDocument(
      (eventsArg, speedArg) => {
        window.__EVENTS_DATA__ = eventsArg;
        window.__REPLAY_SPEED__ = speedArg;
      },
      events,
      job.speed
    );

    // 5. Set content directly — avoids file:// origin issues completely
    console.log(`${logPrefix} Setting replay HTML content...`);
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    console.log(`${logPrefix} Replay page loaded`);

    // Wait for rrweb to have initialized (or error out)
    try {
      await page.waitForFunction(
        "window.__REPLAY_READY__ === true || window.__REPLAY_ERROR__",
        { timeout: 30000, polling: 200 }
      );
    } catch {
      // Collect diagnostic info from the page
      const diag = await page.evaluate(() => ({
        ready: window.__REPLAY_READY__,
        error: window.__REPLAY_ERROR__,
        logs: window.__REPLAY_LOG__ || [],
        rrwebType: typeof window.rrweb,
        rrwebKeys:
          typeof window.rrweb === "object" && window.rrweb
            ? Object.keys(window.rrweb)
            : null,
        bodyHtmlLen: document.body ? document.body.innerHTML.length : 0,
      })).catch((e) => ({ evalError: e.message }));
      console.error(`${logPrefix} init diagnostics:`, JSON.stringify(diag));
      throw new Error(
        `rrweb Replayer failed to initialize within 30 seconds — ${JSON.stringify(
          diag
        )}`
      );
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
      if (frameCounter === 1 || frameCounter % 30 === 0) {
        console.log(`${logPrefix} captured ${frameCounter} frames`);
      }
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
    console.log(`${logPrefix} Screencast started`);

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

    // Periodic progress updates during capture. Prefer the replayer's
    // reported current time (so the bar reflects actual playback
    // progress); fall back to wall-clock elapsed if the page eval fails.
    const captureStart = Date.now();
    const progressTimer = setInterval(async () => {
      let pct;
      try {
        const state = await page.evaluate(() => ({
          cur: window.__REPLAY_CURRENT_MS__ || 0,
          total: window.__REPLAY_TOTAL_MS__ || 0,
          done: window.__REPLAY_DONE__ === true,
        }));
        const total = state.total || expectedDurationMs;
        const frac = total > 0 ? Math.min(state.cur / total, 1) : 0;
        pct = Math.min(50 + Math.floor(frac * 24), 74);
      } catch {
        const elapsed = Date.now() - captureStart;
        pct = Math.min(
          50 + Math.floor((elapsed / expectedDurationMs) * 24),
          74
        );
      }
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
