#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/CyberTechArmor/rrweb-video-converter.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/rrweb-video-converter}"
BRANCH="main"

info()  { printf "\033[1;34m[INFO]\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m[WARN]\033[0m %s\n" "$1"; }
error() { printf "\033[1;31m[ERROR]\033[0m %s\n" "$1"; exit 1; }

check_cmd() { command -v "$1" &>/dev/null; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if check_cmd sudo; then
    SUDO="sudo"
  else
    warn "Not running as root and sudo not found — system package installation will be skipped."
  fi
fi

# ── Detect package manager ─────────────────────────────────────────
PKG_MGR=""
if check_cmd apt-get; then
  PKG_MGR="apt"
elif check_cmd dnf; then
  PKG_MGR="dnf"
elif check_cmd yum; then
  PKG_MGR="yum"
elif check_cmd pacman; then
  PKG_MGR="pacman"
elif check_cmd apk; then
  PKG_MGR="apk"
elif check_cmd brew; then
  PKG_MGR="brew"
fi

info "Detected package manager: ${PKG_MGR:-none}"

# ── Install system dependencies (Chromium libs + ffmpeg) ───────────
install_system_deps() {
  info "Installing system dependencies (Chromium shared libraries, ffmpeg)..."

  case "$PKG_MGR" in
    apt)
      $SUDO apt-get update
      # Packages required to run Puppeteer's headless Chromium on Debian/Ubuntu.
      # Also installs chromium so we can use the system browser if preferred.
      $SUDO apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-liberation \
        ffmpeg \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libexpat1 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libstdc++6 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxkbcommon0 \
        libxrandr2 \
        libxrender1 \
        libxshmfence1 \
        libxss1 \
        libxtst6 \
        xdg-utils 2>&1 | tail -20 || {
          # Retry with t64 variants (Ubuntu 24.04+)
          warn "Some packages not found, retrying with t64 variants (Ubuntu 24.04+)..."
          $SUDO apt-get install -y --no-install-recommends \
            libasound2t64 \
            libatk-bridge2.0-0t64 \
            libatk1.0-0t64 \
            libcups2t64 \
            libxss1 || true
        }
      ;;
    dnf|yum)
      $SUDO $PKG_MGR install -y \
        ffmpeg \
        alsa-lib \
        atk \
        at-spi2-atk \
        cups-libs \
        gtk3 \
        ipa-gothic-fonts \
        libXcomposite \
        libXcursor \
        libXdamage \
        libXext \
        libXi \
        libXrandr \
        libXScrnSaver \
        libXtst \
        nspr \
        nss \
        pango \
        xorg-x11-fonts-100dpi \
        xorg-x11-fonts-75dpi \
        xorg-x11-fonts-cyrillic \
        xorg-x11-fonts-misc \
        xorg-x11-fonts-Type1 \
        xorg-x11-utils
      ;;
    pacman)
      $SUDO pacman -Sy --noconfirm \
        ffmpeg \
        nss \
        alsa-lib \
        atk \
        at-spi2-atk \
        cups \
        gtk3 \
        libxcomposite \
        libxcursor \
        libxdamage \
        libxext \
        libxi \
        libxrandr \
        libxss \
        libxtst \
        nspr \
        pango
      ;;
    apk)
      $SUDO apk add --no-cache \
        ffmpeg \
        chromium \
        nss \
        freetype \
        harfbuzz \
        ca-certificates \
        ttf-freefont
      ;;
    brew)
      brew install ffmpeg
      # Chromium shared libs come with macOS
      ;;
    *)
      warn "Unknown package manager — you'll need to install Chromium dependencies manually."
      warn "See: https://pptr.dev/troubleshooting#chrome-headless-doesnt-launch-on-unix"
      ;;
  esac
}

# ── Pre-flight: core commands ──────────────────────────────────────
info "Checking prerequisites..."

MISSING=()
check_cmd git  || MISSING+=("git")
check_cmd node || MISSING+=("node")
check_cmd npm  || MISSING+=("npm")

if [ ${#MISSING[@]} -ne 0 ]; then
  error "Missing required commands: ${MISSING[*]}
Install them and re-run this script.
  - git:  https://git-scm.com
  - node: https://nodejs.org (v18+)
  - npm:  comes with node"
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js v18+ required (found v$(node -v))"
fi

# ── Install system deps (unless skipped) ───────────────────────────
if [ "${SKIP_SYSTEM_DEPS:-}" = "1" ]; then
  warn "SKIP_SYSTEM_DEPS=1 — skipping system dependency install"
else
  if [ -n "$PKG_MGR" ] && { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; }; then
    install_system_deps
  else
    warn "Skipping system dependency install (no package manager or sudo)"
    warn "If Puppeteer fails to launch, install Chromium runtime libraries manually."
  fi
fi

# Re-check ffmpeg
if ! check_cmd ffmpeg; then
  error "ffmpeg is not installed. Install it and re-run this script."
fi

# ── Detect Chrome/Chromium ─────────────────────────────────────────
CHROME_BIN=""
for bin in google-chrome google-chrome-stable chromium chromium-browser; do
  if check_cmd "$bin"; then
    CHROME_BIN="$(command -v "$bin")"
    info "Found system browser: $CHROME_BIN"
    break
  fi
done

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

# ── Install node dependencies ──────────────────────────────────────
info "Installing backend dependencies..."
npm install

info "Installing frontend dependencies..."
cd frontend && npm install && cd ..

# ── Build frontend ─────────────────────────────────────────────────
info "Building frontend..."
cd frontend && npx vite build && cd ..

# ── Create jobs directory ──────────────────────────────────────────
mkdir -p jobs

# ── Write .env file so the worker can find the right Chrome ────────
ENV_FILE="$INSTALL_DIR/.env"
{
  echo "# Generated by install.sh"
  echo "PORT=3001"
  if [ -n "$CHROME_BIN" ]; then
    echo "PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN"
  fi
} > "$ENV_FILE"
info "Wrote $ENV_FILE"

# ── Verify Puppeteer can launch Chromium ───────────────────────────
info "Verifying Puppeteer can launch Chromium..."
set +e
node -e "
const puppeteer = require('puppeteer');
(async () => {
  try {
    const b = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    await b.close();
    console.log('OK');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
" PUPPETEER_EXECUTABLE_PATH="${CHROME_BIN:-}"
VERIFY_RC=$?
set -e

if [ $VERIFY_RC -ne 0 ]; then
  warn "Chromium launch test failed. The service may not work until this is resolved."
  warn "See https://pptr.dev/troubleshooting for help."
else
  info "Chromium launch test passed."
fi

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
