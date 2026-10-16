#!/usr/bin/env bash
set -euo pipefail

if [ "${ORKESTR_INSTALL_DEV_DEPS:-0}" = "1" ] || [ "${ORKESTR_BUILD_WEB_FROM_SOURCE:-0}" = "1" ]; then
  if [ -f package-lock.json ]; then
    npm ci --include=dev
  else
    npm install --include=dev
  fi
  node scripts/patch-whatsapp-media-id.mjs
  exit 0
fi

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

server_build_deps=()
while IFS= read -r dep; do
  [ -n "$dep" ] || continue
  server_build_deps[${#server_build_deps[@]}]="$dep"
done < <(node <<'NODE'
const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
const dev = pkg.devDependencies || {};
for (const name of ["typescript", "@types/node", "@types/ws"]) {
  const version = dev[name];
  if (version) console.log(`${name}@${version}`);
}
NODE
)

if [ "${#server_build_deps[@]}" -gt 0 ]; then
  # Install only the compiler and its type packages, in a folder without the
  # project's package.json, so npm resolves just these three packages instead
  # of re-resolving every devDependency from the registry (which can trip npm
  # resolver bugs on unrelated newly published peers). Link them in.
  tools_dir="$PWD/.runtime-build-tools"
  rm -rf "$tools_dir"
  mkdir -p "$tools_dir"
  npm install --prefix "$tools_dir" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "${server_build_deps[@]}"
  mkdir -p node_modules/.bin node_modules/@types
  ln -sfn "$tools_dir/node_modules/typescript" node_modules/typescript
  ln -sfn "$tools_dir/node_modules/.bin/tsc" node_modules/.bin/tsc
  for types in node ws; do
    if [ -d "$tools_dir/node_modules/@types/$types" ]; then
      ln -sfn "$tools_dir/node_modules/@types/$types" "node_modules/@types/$types"
    fi
  done
fi

if [ ! -x node_modules/.bin/tsc ]; then
  echo "Runtime dependency install did not provide the TypeScript compiler required by build:server." >&2
  exit 1
fi

# The compiler-only install above disables lifecycle scripts; verify the media
# compatibility patch again after the final dependency operation.
node scripts/patch-whatsapp-media-id.mjs
