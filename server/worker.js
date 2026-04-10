require("./env");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer");
const {
  getQueuedJob,
  updateJobStatus,
  markJobStarted,
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

// Log memory usage so leaks show up in the worker log immediately
function logMem(prefix, step) {
  const m = process.memoryUsage();
  console.log(
    `${prefix} [mem:${step}] rss=${Math.round(
      m.rss / 1024 / 1024
    )}MB heap=${Math.round(m.heapUsed / 1024 / 1024)}MB external=${Math.round(
      m.external / 1024 / 1024
    )}MB`
  );
}

// Await a promise but enforce a hard timeout. Used for browser close
// and other cleanup operations that may hang in LXC containers under
// memory pressure.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
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
  console.log(
    `${logPrefix} Start (${job.width}x${job.height} @ ${job.fps}fps, speed ${job.speed}x, preset ${job.preset}, crf ${job.crf})`
  );
  logMem(logPrefix, "start");
  markJobStarted.run(5, job.id);

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
    //
    //    Frames are streamed directly to disk as they arrive instead
    //    of being buffered in RAM. For a long 1080p capture the
    //    in-memory buffer could easily exceed 300 MB, which tips over
    //    constrained LXC containers on the second job of a session.
    console.log(`${logPrefix} Starting screencast...`);
    const client = await page.createCDPSession();

    // Ensure the frames dir exists before we start receiving frames
    fs.mkdirSync(framesDir, { recursive: true });

    let frameCounter = 0;
    let frameWriteError = null;

    client.on("Page.screencastFrame", (frame) => {
      const idx = frameCounter++;
      const framePath = path.join(
        framesDir,
        `frame_${String(idx).padStart(6, "0")}.jpg`
      );
      try {
        fs.writeFileSync(framePath, Buffer.from(frame.data, "base64"));
        if (idx === 0 || (idx + 1) % 30 === 0) {
          console.log(`${logPrefix} captured ${idx + 1} frames`);
        }
      } catch (e) {
        if (!frameWriteError) {
          frameWriteError = e;
          console.error(
            `${logPrefix} frame write error (${framePath}): ${e.message}`
          );
        }
      }
      // Ack asynchronously — if it throws, the session is gone, doesn't matter
      client
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => {});
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

    if (frameWriteError) {
      throw new Error(
        `Frame write failed during capture: ${frameWriteError.message}`
      );
    }

    const totalFrames = frameCounter;
    console.log(
      `${logPrefix} Captured ${totalFrames} frames over ${(
        captureElapsedMs / 1000
      ).toFixed(2)}s wall-clock (finished=${replayFinished})`
    );
    logMem(logPrefix, "post-capture");
    updateJobStatus.run("processing", 85, job.id);

    if (totalFrames === 0) {
      throw new Error("No frames were captured during replay");
    }

    // Compute ffmpeg input fps from actual wall-clock elapsed time
    // rather than raw event timestamps. This is self-correcting:
    //   - skipInactive jumps through idle periods → shorter wall-clock
    //   - replay runs exactly in real time → wall-clock ≈ active duration
    //   - CDP captures at variable rate → N/elapsed is still correct
    const targetDurationSec = Math.max(captureElapsedMs / 1000, 0.5);
    const inputFps = totalFrames / targetDurationSec;
    console.log(
      `${logPrefix} Timing: ${totalFrames} frames over ${targetDurationSec.toFixed(
        2
      )}s wall-clock → input ${inputFps.toFixed(2)} fps, output ${job.fps} fps`
    );

    // 7. Frames are already on disk — streamed straight from the CDP
    //    screencast handler. Nothing to do here except proceed to encode.

    // 8. Encode with ffmpeg via direct child_process.spawn.
    //    Using spawn directly (instead of fluent-ffmpeg) because:
    //      - We can parse stderr line-by-line AND handle \r progress
    //        updates (ffmpeg uses \r to rewrite progress on one line).
    //      - We get reliable exit codes and signals on timeout/crash.
    //      - No reliance on fluent-ffmpeg's inconsistent progress
    //        event emission for image-sequence inputs.
    console.log(`${logPrefix} Encoding with ffmpeg (${totalFrames} frames)...`);
    const encodeStart = Date.now();

    // Use the preset, CRF, and codec specified on the job. The API
    // and frontend expose these via a Quality dropdown; default is
    // h264 / fast / crf 26.
    const preset = job.preset || "fast";
    const codec = job.codec || "h264";
    const defaultCrf = codec === "h265" ? 30 : 26;
    const crf = typeof job.crf === "number" ? job.crf : defaultCrf;

    // Build codec-specific ffmpeg args. libx265 at similar-perceived
    // quality produces ~40% smaller files than libx264 but is ~3-5x
    // slower to encode. The hvc1 tag is required for QuickTime/Safari
    // playback and is safer than hev1.
    const codecArgs =
      codec === "h265"
        ? ["-vcodec", "libx265", "-tag:v", "hvc1",
           // Tell libx265 to keep logs quiet; otherwise it prints
           // 10+ lines of info to stderr that break our progress
           // parser on the first run.
           "-x265-params", "log-level=error"]
        : ["-vcodec", "libx264"];

    const ffmpegArgs = [
      "-y",
      "-r", String(inputFps.toFixed(4)),
      "-i", path.join(framesDir, "frame_%06d.jpg"),
      ...codecArgs,
      "-pix_fmt", "yuv420p",
      "-s", `${job.width}x${job.height}`,
      "-r", String(job.fps),
      "-preset", preset,
      "-crf", String(crf),
      "-movflags", "+faststart",
      "-threads", "0",
      outputPath,
    ];

    console.log(`${logPrefix} ffmpeg ${ffmpegArgs.join(" ")}`);

    await new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderrTail = "";
      let stderrBuf = "";
      let lastDoneFrames = 0;

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrBuf += text;
        // Keep a rolling tail for error diagnostics
        stderrTail = (stderrTail + text).slice(-4000);

        // ffmpeg progress lines end with \r; split on both \r and \n.
        const parts = stderrBuf.split(/[\r\n]/);
        stderrBuf = parts.pop() || "";
        for (const line of parts) {
          if (!line.trim()) continue;
          const fm = /frame=\s*(\d+)/.exec(line);
          if (fm) {
            const doneFrames = parseInt(fm[1], 10);
            if (doneFrames > lastDoneFrames) {
              lastDoneFrames = doneFrames;
              const pct =
                85 + Math.floor((doneFrames / totalFrames) * 9);
              try {
                updateJobStatus.run(
                  "processing",
                  Math.min(pct, 94),
                  job.id
                );
              } catch {
                // ignore
              }
              if (doneFrames % 30 === 0 || doneFrames === totalFrames) {
                console.log(
                  `${logPrefix} ffmpeg: ${doneFrames}/${totalFrames} frames`
                );
              }
            }
          }
          // Surface real errors
          if (/error|failed|invalid data|no such file/i.test(line)) {
            console.warn(`${logPrefix} ffmpeg stderr: ${line.trim()}`);
          }
        }
      });

      proc.on("error", (err) => {
        console.error(`${logPrefix} ffmpeg spawn error:`, err.message);
        reject(err);
      });

      // Hard timeout so a hung ffmpeg can't stall the worker forever
      const timeoutMs = 10 * 60 * 1000; // 10 minutes
      const timeout = setTimeout(() => {
        console.error(
          `${logPrefix} ffmpeg timeout (${timeoutMs / 1000}s), killing process`
        );
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);

      proc.on("close", (code, signal) => {
        clearTimeout(timeout);
        const elapsed = Math.round((Date.now() - encodeStart) / 1000);
        if (code === 0) {
          console.log(`${logPrefix} ffmpeg done in ${elapsed}s`);
          resolve();
        } else {
          const err = new Error(
            `ffmpeg exited with code ${code}${
              signal ? ` (signal ${signal})` : ""
            } after ${elapsed}s\nLast stderr:\n${stderrTail}`
          );
          reject(err);
        }
      });
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

    // Store the capture wall-clock duration as the authoritative
    // video duration. This matches what ffmpeg actually produced
    // because we set the input framerate from this exact value.
    const videoDurationMs = Math.round(captureElapsedMs);
    completeJob.run(stats.size, videoDurationMs, job.id);
    console.log(
      `${logPrefix} Complete — ${(stats.size / 1024 / 1024).toFixed(
        2
      )} MB, ${(videoDurationMs / 1000).toFixed(2)}s duration`
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
    // ── Aggressive cleanup to prevent resource leaks across jobs ──
    // In constrained LXC containers, a lingering Chromium process from
    // the previous job will exhaust memory and cause the next job to
    // hang. We explicitly detach the CDP session, close the page,
    // close the browser with a timeout, and finally SIGKILL the
    // underlying process if close() didn't return in time.
    if (browser) {
      // 1. Detach CDP session if we still have one
      // (client is scoped in the try block; we can't reference it
      // here, but browser.close() will handle it via cascade.)

      // 2. Try to close the browser cleanly, with a hard timeout
      try {
        await withTimeout(browser.close(), 5000, "browser.close");
      } catch (e) {
        console.warn(
          `${logPrefix} browser.close failed/timed out: ${e.message}`
        );
      }

      // 3. Force-kill the underlying Chrome process if it's still running
      try {
        const proc = browser.process();
        if (proc && proc.pid && !proc.killed) {
          console.warn(
            `${logPrefix} browser process still alive, sending SIGKILL to pid ${proc.pid}`
          );
          try {
            process.kill(proc.pid, "SIGKILL");
          } catch (e) {
            // ESRCH means process already gone — fine
            if (e.code !== "ESRCH") {
              console.warn(
                `${logPrefix} SIGKILL failed: ${e.message}`
              );
            }
          }
        }
      } catch {
        // ignore — best-effort
      }
    }

    // 4. Nudge GC if exposed (run node --expose-gc if desired)
    if (global.gc) {
      try {
        global.gc();
      } catch {
        // ignore
      }
    }

    logMem(logPrefix, "end-of-job");
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
