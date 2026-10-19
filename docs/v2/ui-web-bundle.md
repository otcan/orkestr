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

The exact CLI was installed in an isolated V2 tool directory using the pinned Cargo wrapper and `cargo install wasm-bindgen-cli --version 0.2.129 --locked`. Operators must provide that directory on PATH; the script never installs tools or changes the product lock. Release bundle size and generated Dioxus bootstrap must be verified separately.

The UI lane reported 19 bridge cases at source `221549c0`, including a synthetic same-origin smoke. That smoke uses a tiny empty WASM and is not generated glue, a Dioxus render, or browser cookie/DOM acceptance. The integrated cookie/CSRF bridge previously passed 18 tests; `bash -n v2/apps/ui/scripts/bundle.sh` passes.

Once the exact CLI is available through an approved tool path, run the command,
then separately validate the generated assets against the integrated server's
explicit `ORKESTR_V2_UI_DIST` snapshot. Keep newer server/auth sources intact;
static serving integration is coordinator owned. Real browser checks require the
managed browser lease flow; no Chrome or profile is launched by these scripts.

## Integrated bundle checkpoint

Against integration source `e9ea830e`, the exact installed CLI and wrapper recipe completed successfully. The generated WASM is 1,447,668 bytes (SHA-256 `4b191a94f6c9dcb9b4963873050f4bb54dfb7337ed2b7939fd72a406d8d6edb5`); all ten generated files fit the static snapshot bounds. An owned isolated server served all ten files byte-for-byte with no-store/nosniff and correct WASM MIME. Unauthenticated browser session lookup returned JSON 401; an unknown API route returned JSON 404. The first smoke launch was refused because its synthetic bootstrap token was too short; a corrected synthetic token passed without changing server validation.

This is generated-asset and actual-server HTTP evidence, not execution of the generated Dioxus client in a browser. Browser rendering, cookie/CSRF interaction, keyboard/accessibility and native acceptance remain pending. Generated artifacts are not committed.
