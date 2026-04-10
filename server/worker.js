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

// Serialize a JS value for safe embedding inside a <script> tag.
// JSON is a subset of JS expressions, but we also need to escape
// sequences that would corrupt the HTML parse or break JS string
// literals in older parsers:
//   < / > / &   — defense against </script> and HTML parser quirks
//   U+2028/2029 — pre-ES2019 line terminators in JS string literals
function htmlSafeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildReplayHtml(events, job) {
  // Use function form of .replace so '$' sequences in the replacement
  // values aren't interpreted as back-references.
  return REPLAY_HTML_TEMPLATE
    .replace("/* __RRWEB_CSS__ */", () => escapeForHtmlEmbed(RRWEB_CSS_CONTENT))
    .replace("/* __RRWEB_JS__ */", () => escapeForHtmlEmbed(RRWEB_JS_CONTENT))
    .replace("/* __EVENTS_JSON__ */ null", () => htmlSafeJson(events))
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

    // 2. Build the replay HTML — rrweb JS/CSS, events JSON, and
    //    visibility override are all inlined so the page is fully
    //    self-contained and doesn't rely on any CDP-injected state
    //    (evaluateOnNewDocument doesn't fire for setContent because
    //    setContent reuses the current document via document.open).
    console.log(`${logPrefix} Building replay HTML...`);
    const html = buildReplayHtml(events, job);
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

    // 4. Tell Chromium to emulate a focused page — belt-and-suspenders
    //    alongside the inline document.visibilityState override.
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

    updateJobStatus.run("processing", 35, job.id);

    // 5. Set the replay HTML content. Everything is inlined — rrweb JS,
    //    rrweb CSS, events JSON, visibility override — so no additional
    //    CDP injection is needed. This avoids the evaluateOnNewDocument +
    //    setContent timing problem entirely.
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

    // 5. Start CDP screencast. Use JPEG (quality 80) instead of PNG:
    //    ~10x less data through CDP, ~5x faster frame-write to disk,
    //    ~2x faster ffmpeg input decode. Visual loss is imperceptible
    //    after libx264 re-encodes anyway.
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

    // Record wall-clock start before we begin capturing. We'll use
    // the actual elapsed wall time to compute the ffmpeg input fps,
    // which is self-correcting regardless of rrweb's skipInactive,
    // rAF timing skew, or CDP frame rate variance.
    const captureStart = Date.now();

    await client.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
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
      )}s (pre-skipInactive), waiting up to ${Math.round(
        waitTimeout / 1000
      )}s`
    );

    // Periodic progress updates during capture. Prefer the replayer's
    // reported current time (so the bar reflects actual playback
    // progress); fall back to wall-clock elapsed if the page eval fails.
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
    await new Promise((r) => setTimeout(r, 1000));

    // Stop screencast and record capture end time
    try {
      await client.send("Page.stopScreencast");
    } catch {
      // already stopped
    }
    const captureEnd = Date.now();
    const captureElapsedMs = captureEnd - captureStart;

    console.log(
      `${logPrefix} Captured ${frames.length} frames over ${(
        captureElapsedMs / 1000
      ).toFixed(2)}s wall-clock (finished=${replayFinished})`
    );
    updateJobStatus.run("processing", 75, job.id);

    if (frames.length === 0) {
      throw new Error("No frames were captured during replay");
    }

    // Compute ffmpeg input fps from actual wall-clock elapsed time
    // rather than raw event timestamps. This is self-correcting:
    //   - skipInactive jumps through idle periods → shorter wall-clock
    //   - replay runs exactly in real time → wall-clock ≈ active duration
    //   - CDP captures at variable rate → N/elapsed is still correct
    const targetDurationSec = Math.max(captureElapsedMs / 1000, 0.5);
    const inputFps = frames.length / targetDurationSec;
    console.log(
      `${logPrefix} Timing: ${frames.length} frames over ${targetDurationSec.toFixed(
        2
      )}s wall-clock → input ${inputFps.toFixed(2)} fps, output ${job.fps} fps`
    );

    // 7. Write frames as JPEGs for ffmpeg input, reporting progress 75→84
    fs.mkdirSync(framesDir, { recursive: true });
    const totalFrames = frames.length;
    for (let i = 0; i < totalFrames; i++) {
      fs.writeFileSync(
        path.join(framesDir, `frame_${String(i).padStart(6, "0")}.jpg`),
        frames[i]
      );
      if (i % 10 === 0 || i === totalFrames - 1) {
        const pct = 75 + Math.floor((i / Math.max(totalFrames - 1, 1)) * 9);
        try {
          updateJobStatus.run("processing", Math.min(pct, 84), job.id);
        } catch {
          // ignore
        }
      }
    }
    console.log(`${logPrefix} Wrote ${totalFrames} frames to disk`);
    updateJobStatus.run("processing", 85, job.id);

    // 8. Encode with ffmpeg. Use 'progress' events to tick 85→94 during
    //    encoding so the UI moves smoothly even on slow 1080p runs.
    console.log(`${logPrefix} Encoding with ffmpeg (${totalFrames} frames)...`);
    const encodeStart = Date.now();
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg()
        .input(path.join(framesDir, "frame_%06d.jpg"))
        .inputFPS(inputFps)
        .videoCodec("libx264")
        .outputOptions([
          "-pix_fmt yuv420p",
          `-s ${job.width}x${job.height}`,
          // Output framerate — ffmpeg will duplicate/drop frames as
          // needed to match this while preserving the input timing
          `-r ${job.fps}`,
          // ultrafast: ~3x faster than 'fast' at ~10% larger file size.
          // For UI recordings this tradeoff is almost always worth it.
          "-preset ultrafast",
          "-crf 23",
          "-movflags +faststart",
          // Use all available cores
          `-threads 0`,
        ])
        .output(outputPath)
        .on("start", (line) => console.log(`${logPrefix} ffmpeg: ${line}`))
        .on("stderr", (line) => {
          // ffmpeg writes progress info to stderr; log sparingly
          if (/frame=/.test(line)) {
            const m = /frame=\s*(\d+)/.exec(line);
            if (m) {
              const doneFrames = parseInt(m[1], 10);
              const pct = 85 + Math.floor((doneFrames / totalFrames) * 9);
              try {
                updateJobStatus.run(
                  "processing",
                  Math.min(pct, 94),
                  job.id
                );
              } catch {
                // ignore
              }
            }
          }
        })
        .on("progress", (progress) => {
          if (progress && progress.frames) {
            const pct =
              85 + Math.floor((progress.frames / totalFrames) * 9);
            try {
              updateJobStatus.run(
                "processing",
                Math.min(pct, 94),
                job.id
              );
            } catch {
              // ignore
            }
            if (progress.frames % 30 === 0) {
              console.log(
                `${logPrefix} ffmpeg: ${progress.frames}/${totalFrames} frames (${
                  progress.currentFps || 0
                } fps)`
              );
            }
          }
        })
        .on("end", () => {
          console.log(
            `${logPrefix} ffmpeg done in ${Math.round(
              (Date.now() - encodeStart) / 1000
            )}s`
          );
          resolve();
        })
        .on("error", (err) => {
          console.error(`${logPrefix} ffmpeg error:`, err.message);
          reject(err);
        });
      cmd.run();
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
