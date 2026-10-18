# Locked web bundle candidate

`v2/apps/ui/scripts/bundle.sh` builds the web feature with the authorized Cargo
wrapper, `--release --offline --locked`, then runs exactly wasm-bindgen CLI
0.2.129, matching the existing workspace lock. No dx CLI is required for this
minimal web entrypoint. It generates `index.html`, web-target JavaScript glue and
WASM in a new explicit output directory, with no dependency resolution or server
source changes. Existing output directories are never overwritten. Generated
assets must fit the server's 8 MiB/file, 64 MiB/total and 4096-asset bounds.

Example (operator supplies absolute isolated paths):

```sh
V2_CARGO=/absolute/path/to/authorized/v2-cargo \
CARGO_TARGET_DIR=/absolute/path/to/lane-target \
ORKESTR_V2_HOME=/absolute/path/to/isolated-home \
UI_BUNDLE_DIR=/absolute/path/to/new-public-dist \
v2/apps/ui/scripts/bundle.sh
```

Current execution stopped with exit 2 before Cargo or output creation:
`BLOCKED: wasm-bindgen CLI 0.2.129 unavailable; no install attempted`.
Neither dx nor wasm-bindgen was found in the inspected tool paths. No tool was
installed. Release bundle generation, size and the generated Dioxus bootstrap
remain unverified. The previously compiled debug WASM is approximately 39 MiB
and is not a serveable bundle under the static snapshot limit.

`node --test v2/apps/ui/tests/*.test.mjs` passes 19 cases, including a synthetic
same-origin HTTP smoke on isolated loopback port 47139. That smoke fetches HTML,
a module and a tiny empty WASM with application/wasm, instantiates the synthetic
WASM, and runs the real request bridge against the same synthetic origin. It is
not the production server, generated glue, a Dioxus render, or browser cookie/DOM
acceptance. `bash -n v2/apps/ui/scripts/bundle.sh` passes; its post-gate bundle
steps have not executed.

Once the exact CLI is available through an approved tool path, run the command,
then separately validate the generated assets against the integrated server's
explicit `ORKESTR_V2_UI_DIST` snapshot. Keep newer server/auth sources intact;
static serving integration is coordinator owned. Real browser checks require the
managed browser lease flow; no Chrome or profile is launched by these scripts.
