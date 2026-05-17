#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install Orkestr locally.

Usage:
  scripts/install.sh [--local] [--serve]

Environment:
  ORKESTR_REPO_URL      Git repository to clone when not running --local.
  ORKESTR_INSTALL_DIR   Install directory. Defaults to ~/.orkestr-src/orkestr-oss.
  ORKESTR_HOST          Bind host. Defaults to 127.0.0.1.
  ORKESTR_PORT          Bind port. Defaults to 19812.
USAGE
}

local_mode=0
serve=0
for arg in "$@"; do
  case "$arg" in
    --local) local_mode=1 ;;
    --serve) serve=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need node
need npm

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22 or newer is required. Found: $(node --version)" >&2
  exit 1
fi

repo_dir="${ORKESTR_INSTALL_DIR:-$HOME/.orkestr-src/orkestr-oss}"
if [ "$local_mode" -eq 1 ]; then
  repo_dir="$(pwd)"
else
  need git
  repo_url="${ORKESTR_REPO_URL:-https://github.com/orkestr/orkestr-oss.git}"
  if [ -d "$repo_dir/.git" ]; then
    git -C "$repo_dir" pull --ff-only
  else
    mkdir -p "$(dirname "$repo_dir")"
    git clone "$repo_url" "$repo_dir"
  fi
fi

cd "$repo_dir"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npm run build

export ORKESTR_HOST="${ORKESTR_HOST:-127.0.0.1}"
export ORKESTR_PORT="${ORKESTR_PORT:-19812}"

cat <<EOF

Orkestr installed.

Start:
  cd $repo_dir
  ORKESTR_HOST=$ORKESTR_HOST ORKESTR_PORT=$ORKESTR_PORT npm start

Open:
  http://$ORKESTR_HOST:$ORKESTR_PORT/setup

EOF

if [ "$serve" -eq 1 ]; then
  npm start
fi
