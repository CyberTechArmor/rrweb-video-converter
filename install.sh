#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/CyberTechArmor/rrweb-video-converter.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/rrweb-video-converter}"
BRANCH="main"

info()  { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m[WARN]\033[0m %s\n" "$1"; }
error() { printf "\033[1;31m[ERROR]\033[0m %s\n" "$1"; exit 1; }

# ── Pre-flight checks ──────────────────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    return 1
  fi
}

info "Checking prerequisites..."

MISSING=()
check_cmd git    || MISSING+=("git")
check_cmd node   || MISSING+=("node")
check_cmd npm    || MISSING+=("npm")
check_cmd ffmpeg || MISSING+=("ffmpeg")

if [ ${#MISSING[@]} -ne 0 ]; then
  error "Missing required commands: ${MISSING[*]}
Install them and re-run this script.
  - git:    https://git-scm.com
  - node:   https://nodejs.org (v18+)
  - npm:    comes with node
  - ffmpeg: https://ffmpeg.org"
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js v18+ required (found v$(node -v))"
fi

# Check for Chrome/Chromium (Puppeteer needs one)
CHROME_FOUND=false
for bin in google-chrome chromium chromium-browser google-chrome-stable; do
  if check_cmd "$bin"; then
    CHROME_FOUND=true
    info "Found browser: $(command -v "$bin")"
    break
  fi
done

if [ "$CHROME_FOUND" = false ]; then
  warn "No Chrome/Chromium found in PATH."
  warn "Puppeteer will download Chromium during npm install (this may take a while)."
fi

# ── Clone or update repo ───────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing installation found at $INSTALL_DIR — pulling latest..."
  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  info "Cloning repository into $INSTALL_DIR..."
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── Install dependencies ───────────────────────────────────────────
info "Installing backend dependencies..."
npm install

info "Installing frontend dependencies..."
cd frontend && npm install && cd ..

# ── Build frontend ─────────────────────────────────────────────────
info "Building frontend..."
cd frontend && npx vite build && cd ..

# ── Create jobs directory ──────────────────────────────────────────
mkdir -p jobs

# ── Done ───────────────────────────────────────────────────────────
cat <<DONE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  rrweb Video Converter installed successfully
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Location:  $INSTALL_DIR

  Start the service:
    cd $INSTALL_DIR
    npm start

  Or use Docker:
    cd $INSTALL_DIR
    docker compose up --build

  The service will be available at:
    http://localhost:3001

DONE
