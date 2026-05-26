#!/usr/bin/env bash
set -euo pipefail

if [ "${ORKESTR_INSTALL_DEV_DEPS:-0}" = "1" ] || [ "${ORKESTR_BUILD_WEB_FROM_SOURCE:-0}" = "1" ]; then
  if [ -f package-lock.json ]; then
    npm ci --include=dev
  else
    npm install --include=dev
  fi
  exit 0
fi

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

mapfile -t server_build_deps < <(node <<'NODE'
const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
const dev = pkg.devDependencies || {};
for (const name of ["typescript", "@types/node", "@types/ws"]) {
  const version = dev[name];
  if (version) console.log(`${name}@${version}`);
}
NODE
)

if [ "${#server_build_deps[@]}" -gt 0 ]; then
  npm install --omit=dev --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "${server_build_deps[@]}"
fi
