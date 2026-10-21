#!/usr/bin/env bash
set -euo pipefail
# Run from anywhere; keep Cargo under the host's authorized wrapper.
ui_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
workspace_dir=$(cd -- "$ui_dir/../.." && pwd)
: "${V2_CARGO:?Set V2_CARGO to the authorized Cargo wrapper}"
: "${CARGO_TARGET_DIR:?Set an absolute lane target directory}"
: "${UI_BUNDLE_DIR:?Set an empty absolute public output directory}"
case "$CARGO_TARGET_DIR" in /*) ;; *) echo 'CARGO_TARGET_DIR must be absolute' >&2; exit 2;; esac
case "$UI_BUNDLE_DIR" in /*) ;; *) echo 'UI_BUNDLE_DIR must be absolute' >&2; exit 2;; esac
command -v wasm-bindgen >/dev/null || { echo 'BLOCKED: wasm-bindgen CLI 0.2.129 unavailable; no install attempted' >&2; exit 2; }
[[ $(wasm-bindgen --version) == 'wasm-bindgen 0.2.129' ]] || { echo 'BLOCKED: expected wasm-bindgen 0.2.129 matching Cargo.lock' >&2; exit 2; }
[[ ! -e "$UI_BUNDLE_DIR" ]] || { echo 'Refusing to overwrite existing bundle directory' >&2; exit 2; }
cd -- "$workspace_dir"
features=web
if [[ ${UI_EXECUTION_CONTROLS:-0} == 1 ]]; then
    [[ ${UI_SERVER_CANDIDATE:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'Control bundle requires an exact registered matching server candidate SHA' >&2; exit 2; }
    features=web,execution-controls
fi
# wasm-release (workspace Cargo.toml): size-optimized, LTO, one codegen unit.
"$V2_CARGO" build --profile wasm-release --offline --locked -p orkestr-v2-ui --no-default-features --features "$features" --target wasm32-unknown-unknown
mkdir -- "$UI_BUNDLE_DIR"
# The name and producers sections are debugging metadata only (about a
# third of the download); browsers do not need them to run the bundle.
wasm-bindgen "$CARGO_TARGET_DIR/wasm32-unknown-unknown/wasm-release/orkestr-v2-ui.wasm" --target web --out-dir "$UI_BUNDLE_DIR" --out-name orkestr_v2_ui --no-typescript --remove-name-section --remove-producers-section
# Content-versioned URLs: index.html is always revalidated, so a new build
# can never run against a stale cached script or WebAssembly module.
js_version=$(sha256sum "$UI_BUNDLE_DIR/orkestr_v2_ui.js" | cut -c1-16)
wasm_version=$(sha256sum "$UI_BUNDLE_DIR/orkestr_v2_ui_bg.wasm" | cut -c1-16)
cat > "$UI_BUNDLE_DIR/index.html" <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"><title>Orkestr</title></head>
<body><div id="main"></div><script type="module">import init from './orkestr_v2_ui.js?v=$js_version'; await init({module_or_path: './orkestr_v2_ui_bg.wasm?v=$wasm_version'});</script></body></html>
HTML
python3 - "$UI_BUNDLE_DIR" <<'PYTHON'
from pathlib import Path
import sys
files = list(Path(sys.argv[1]).rglob('*'))
assets = [p for p in files if p.is_file()]
if len(assets) > 4096 or any(p.stat().st_size > 8*1024*1024 for p in assets) or sum(p.stat().st_size for p in assets) > 64*1024*1024:
    sys.exit('BLOCKED: bundle exceeds static snapshot limits; candidate retained for inspection')
PYTHON
printf 'Bundle candidate: %s\n' "$UI_BUNDLE_DIR"
