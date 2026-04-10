# rrweb Video Converter

A self-contained service that converts [rrweb](https://github.com/rrweb-io/rrweb) session recordings into MP4 videos. Upload a JSON file of rrweb events and get back a rendered video with cursor movement and click indicators.

## Architecture

```
Frontend (React)          API (Express)           Worker (Background)
─────────────────        ──────────────          ───────────────────
Upload JSON       →      POST /api/jobs
                         → saves JSON to disk
                         → queues render job      → picks up job
                                                  → spins up headless browser
                                                  → replays rrweb events
                                                  → captures via screencast
                                                  → encodes with ffmpeg
                                                  → saves MP4
Poll status        →     GET /api/jobs/:id
                         → returns status/progress
Download video     →     GET /api/jobs/:id/download
                         → streams MP4 file
```

## API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/jobs` | Upload rrweb JSON, returns `{ jobId, status }` |
| GET | `/api/jobs/:id` | Job status: `queued`, `processing`, `done`, `failed` |
| GET | `/api/jobs/:id/download` | Download rendered MP4 |
| DELETE | `/api/jobs/:id` | Cleanup job + files |

### POST /api/jobs

Accepts multipart upload with field name `file`. Optional query params:

| Param | Default | Description |
|-------|---------|-------------|
| `width` | 1280 | Video width in pixels |
| `height` | 720 | Video height in pixels |
| `fps` | 15 | Frames per second |
| `speed` | 1 | Playback speed multiplier |

## Quick Start

### With Docker (recommended)

```bash
docker compose up --build
```

Open http://localhost:3001

### Without Docker

Prerequisites: Node.js 18+, Chromium/Chrome, ffmpeg

```bash
# Install dependencies
npm install

# Build frontend
npm run build:frontend

# Start server + worker
npm start
```

The service runs on http://localhost:3001.

### Development

```bash
npm run dev
```

This starts the API server, background worker, and Vite dev server concurrently. The frontend dev server runs on port 3000 with API proxy to port 3001.

## How It Works

1. **Upload**: The frontend uploads an rrweb events JSON file via multipart form POST
2. **Queue**: The API saves the file and creates a job record in SQLite with status `queued`
3. **Process**: The background worker picks up the job, launches headless Chromium, loads a page with rrweb-player, and replays the events
4. **Capture**: CDP screencast captures frames as PNGs during replay
5. **Encode**: ffmpeg encodes the captured frames into an H.264 MP4
6. **Download**: The frontend polls for completion and presents a video preview + download link

## Configuration

- Jobs older than 24 hours are automatically cleaned up by the worker
- One job processes at a time (queue-based, no parallelism)
- SQLite database for job tracking (no external dependencies)
- All job files stored in `jobs/{jobId}/` directory

## Troubleshooting

### `libnss3.so: cannot open shared object file`

Puppeteer's downloaded Chromium needs several shared libraries to run on Linux. The `install.sh` script installs them automatically via `apt`/`dnf`/`pacman`. If you see this error, run:

```bash
./install.sh
```

...again as root or with `sudo`, or install the packages manually:

**Debian/Ubuntu:**
```bash
sudo apt-get install -y libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 libasound2 libpango-1.0-0
```

**Fedora/RHEL:**
```bash
sudo dnf install -y nss atk at-spi2-atk gtk3 cups-libs libXcomposite \
  libXdamage libXrandr libXScrnSaver libXtst alsa-lib pango
```

Alternatively, point Puppeteer at a system-installed Chrome/Chromium by setting `PUPPETEER_EXECUTABLE_PATH` in `.env`:

```bash
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" >> .env
```

### Running as root

If running the service as root (e.g., inside a minimal container), Chromium refuses to start without `--no-sandbox`. The worker already passes this flag.

## Tech Stack

- **API**: Express, multer, better-sqlite3, uuid
- **Worker**: Puppeteer (headless Chromium), fluent-ffmpeg
- **Frontend**: React, Vite
- **Replay**: rrweb-player (loaded via CDN in headless browser)
- **Container**: Chromium + ffmpeg on Node.js 20 slim
