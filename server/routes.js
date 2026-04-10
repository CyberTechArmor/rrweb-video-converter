const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const {
  insertJob,
  getJob,
  deleteJob,
} = require("./db");

const router = express.Router();

const JOBS_DIR = path.join(__dirname, "..", "jobs");

// Ensure jobs directory exists
fs.mkdirSync(JOBS_DIR, { recursive: true });

// Multer storage: save uploaded JSON to jobs/{jobId}/input.json
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const jobId = req.jobId || (req.jobId = uuidv4());
    const jobDir = path.join(JOBS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    cb(null, jobDir);
  },
  filename(req, file, cb) {
    cb(null, "input.json");
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max
  fileFilter(req, file, cb) {
    if (
      file.mimetype === "application/json" ||
      file.originalname.endsWith(".json")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only JSON files are accepted"));
    }
  },
});

const ALLOWED_PRESETS = new Set([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
]);

// POST /api/jobs — Upload rrweb JSON, create a job
router.post("/jobs", upload.single("file"), (req, res) => {
  try {
    const jobId = req.jobId;
    const width = parseInt(req.query.width) || 1280;
    const height = parseInt(req.query.height) || 720;
    const fps = parseInt(req.query.fps) || 15;
    const speed = parseFloat(req.query.speed) || 1;

    let preset = String(req.query.preset || "fast").toLowerCase();
    if (!ALLOWED_PRESETS.has(preset)) {
      preset = "fast";
    }

    let crf = parseInt(req.query.crf);
    if (isNaN(crf) || crf < 18 || crf > 32) {
      crf = 23;
    }

    insertJob.run(jobId, width, height, fps, speed, preset, crf);

    res.status(201).json({ jobId, status: "queued" });
  } catch (err) {
    console.error("Error creating job:", err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

// Parse SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) → epoch ms
function sqliteTsToMs(ts) {
  if (!ts) return null;
  // Treat the stored timestamp as UTC
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const n = new Date(iso).getTime();
  return isNaN(n) ? null : n;
}

// GET /api/jobs/:id — Job status
router.get("/jobs/:id", (req, res) => {
  const job = getJob.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // Processing time = completed_at - started_at (if both set),
  // else current time - started_at (while still running).
  let processingTimeMs = null;
  const startedMs = sqliteTsToMs(job.startedAt);
  const completedMs = sqliteTsToMs(job.completedAt);
  if (startedMs) {
    processingTimeMs = (completedMs || Date.now()) - startedMs;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    width: job.width,
    height: job.height,
    fps: job.fps,
    speed: job.speed,
    preset: job.preset,
    crf: job.crf,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    videoDurationMs: job.videoDurationMs,
    processingTimeMs,
    error: job.error,
    fileSize: job.fileSize,
  });
});

// GET /api/jobs/:id/download — Download rendered MP4
router.get("/jobs/:id/download", (req, res) => {
  const job = getJob.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (job.status !== "done") {
    return res.status(404).json({ error: "Video not ready" });
  }

  const mp4Path = path.join(JOBS_DIR, req.params.id, "output.mp4");
  if (!fs.existsSync(mp4Path)) {
    return res.status(404).json({ error: "Video file not found" });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="rrweb-recording-${req.params.id}.mp4"`
  );
  fs.createReadStream(mp4Path).pipe(res);
});

// DELETE /api/jobs/:id — Cleanup job + files
router.delete("/jobs/:id", (req, res) => {
  const job = getJob.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  // Delete files
  const jobDir = path.join(JOBS_DIR, req.params.id);
  fs.rmSync(jobDir, { recursive: true, force: true });

  // Delete DB record
  deleteJob.run(req.params.id);

  res.json({ success: true });
});

module.exports = router;
