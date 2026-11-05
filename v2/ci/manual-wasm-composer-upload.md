# Real WASM composer large-file acceptance

This opt-in harness uses an actual disk-backed File through the production
WASM UI's file chooser. Setup, login, browser security, automatic age-key
enrollment, bounded ciphertext chunks, attachment preparation, Send, history
and reload all use the actual candidate backend. A read-only SQLite query
independently verifies the durable message sequence and complete text hash;
the attachment note must contain the full plaintext SHA and byte length. A
different numeric UID reads and hashes the complete published provider file
and is denied access to Core, bootstrap and ingest identity.

Only authenticated `GET /api/v2/beta` discovery is a configuration fixture.
Its identity comes from the real backend's authenticated browser session and
only exposes that session's actual global conversation. All writes pass through
unchanged. No provider is configured, simulated as successful, or invoked.
Provider execution remains outside this acceptance claim.

An isolated Caddy forwards to the fixture/static proxy and actual backend on
loopback. It uses streaming forwarding with `flush_interval=-1` and no explicit
request body or response timeout caps. These settings can be compared with a
read-only, allowlisted inspection of an operator's active production route.
The harness does not access, reload, or qualify the production listener, TLS,
public network, or any preceding CDN.

Set `CI=true`, `ORKESTR_RUN_WASM_1GB=1`, `V2_SERVER`, `UI_BUNDLE_DIR`,
`EXPECTED_CANDIDATE_COMMIT` (full 40 hex) and a private `ACCEPTANCE_REPORT`.
Build server and web with their full embedded build-identity records for the
same source. Use the project's authorized Cargo wrapper to build the UI's
`web,execution-controls` release bundle via `apps/ui/scripts/bundle.sh`.
The harness checks both source stamps and records every bundle asset hash.
Requirements match `manual-browser-large-upload.md`, plus Caddy. No public
listeners, real credentials, desktop profiles or business providers are used.

Default size is exactly 1,000,000,000 plaintext bytes, preceded by rejection of
an actual 1,000,000,001-byte disk file before the first chunk. Optional
`ORKESTR_ACCEPTANCE_BYTES=1048576` is a 1 MiB fixture smoke check and explicitly
does not qualify the 1 GB boundary. File generation and hashing use 1 MiB
buffers. The source file and private Core/export data are removed on exit.
Normal CI does not run the large acceptance automatically.

Disposable backend/browser units retain 3 GiB/2 GiB memory bounds. Caddy has a
256 MiB bound. Receipts distinguish page-cache-inclusive cgroup MemoryPeak,
main-process VmHWM and a 500 ms sampled sum of process-tree RSS (shared pages
may be counted more than once). Receipts identify the exact frozen candidate;
a later release candidate still needs its own qualification.
