const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "..", "rrweb-converter.db");

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 1280,
    height INTEGER NOT NULL DEFAULT 720,
    fps INTEGER NOT NULL DEFAULT 15,
    speed REAL NOT NULL DEFAULT 1,
    preset TEXT NOT NULL DEFAULT 'fast',
    crf INTEGER NOT NULL DEFAULT 23,
    error TEXT,
    file_size INTEGER,
    video_duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
  )
`);

// Migration: add columns to existing databases created before these were added.
// ALTER TABLE ADD COLUMN throws if the column already exists, so we swallow
// that specific error. This lets old DBs upgrade on restart without losing data.
function addColumnIfMissing(name, def) {
  try {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${def}`);
    console.log(`[db] migrated: added column ${name}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) {
      console.warn(`[db] migration warning for ${name}: ${e.message}`);
    }
  }
}
addColumnIfMissing("preset", "TEXT NOT NULL DEFAULT 'fast'");
addColumnIfMissing("crf", "INTEGER NOT NULL DEFAULT 23");
addColumnIfMissing("video_duration_ms", "INTEGER");
addColumnIfMissing("started_at", "TEXT");

const insertJob = db.prepare(`
  INSERT INTO jobs (id, width, height, fps, speed, preset, crf)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const getJob = db.prepare(`
  SELECT id, status, progress, width, height, fps, speed, preset, crf,
         error, file_size AS fileSize, video_duration_ms AS videoDurationMs,
         created_at AS createdAt, started_at AS startedAt,
         completed_at AS completedAt
  FROM jobs WHERE id = ?
`);

const getQueuedJob = db.prepare(`
  SELECT id, width, height, fps, speed, preset, crf
  FROM jobs WHERE status = 'queued'
  ORDER BY created_at ASC LIMIT 1
`);

const updateJobStatus = db.prepare(`
  UPDATE jobs SET status = ?, progress = ? WHERE id = ?
`);

const markJobStarted = db.prepare(`
  UPDATE jobs SET status = 'processing', progress = ?, started_at = datetime('now')
  WHERE id = ?
`);

const completeJob = db.prepare(`
  UPDATE jobs
  SET status = 'done',
      progress = 100,
      completed_at = datetime('now'),
      file_size = ?,
      video_duration_ms = ?
  WHERE id = ?
`);

const failJob = db.prepare(`
  UPDATE jobs SET status = 'failed', error = ?, completed_at = datetime('now')
  WHERE id = ?
`);

const deleteJob = db.prepare(`DELETE FROM jobs WHERE id = ?`);

const getExpiredJobs = db.prepare(`
  SELECT id FROM jobs WHERE created_at < datetime('now', '-24 hours')
`);

module.exports = {
  db,
  insertJob,
  getJob,
  getQueuedJob,
  updateJobStatus,
  markJobStarted,
  completeJob,
  failJob,
  deleteJob,
  getExpiredJobs,
};
