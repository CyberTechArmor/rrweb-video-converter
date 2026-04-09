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
    error TEXT,
    file_size INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )
`);

const insertJob = db.prepare(`
  INSERT INTO jobs (id, width, height, fps, speed)
  VALUES (?, ?, ?, ?, ?)
`);

const getJob = db.prepare(`
  SELECT id, status, progress, width, height, fps, speed, error, file_size,
         created_at AS createdAt, completed_at AS completedAt
  FROM jobs WHERE id = ?
`);

const getQueuedJob = db.prepare(`
  SELECT id, width, height, fps, speed
  FROM jobs WHERE status = 'queued'
  ORDER BY created_at ASC LIMIT 1
`);

const updateJobStatus = db.prepare(`
  UPDATE jobs SET status = ?, progress = ? WHERE id = ?
`);

const completeJob = db.prepare(`
  UPDATE jobs SET status = 'done', progress = 100, completed_at = datetime('now'), file_size = ?
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
  completeJob,
  failJob,
  deleteJob,
  getExpiredJobs,
};
