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

// POST /api/jobs — Upload rrweb JSON, create a job
router.post("/jobs", upload.single("file"), (req, res) => {
  try {
    const jobId = req.jobId;
    const width = parseInt(req.query.width) || 1280;
    const height = parseInt(req.query.height) || 720;
    const fps = parseInt(req.query.fps) || 15;
    const speed = parseFloat(req.query.speed) || 1;

    insertJob.run(jobId, width, height, fps, speed);

    res.status(201).json({ jobId, status: "queued" });
  } catch (err) {
    console.error("Error creating job:", err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

// GET /api/jobs/:id — Job status
router.get("/jobs/:id", (req, res) => {
  const job = getJob.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    error: job.error,
    fileSize: job.file_size,
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
