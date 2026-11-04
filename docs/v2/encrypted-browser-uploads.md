# Encrypted browser uploads

Native V2 conversation Attach, dropped files and pasted images use a resumable
ciphertext protocol. The limit is **1,000,000,000 plaintext bytes per file**,
with at most eight files selected together. This is not a memory setting or an
outbound WhatsApp allowance. Linked V1 uploads and the existing pasted-text
helper retain their legacy limits. The Python WhatsApp adapter's 16 MiB import
path is not on this native browser path and is deliberately not raised.

The browser uses the existing locked `age-encryption` 0.3.1 package. No CDN,
whole-file base64 JSON, or new handwritten encryption primitive is involved.
The UI bundle includes a local `encrypted_upload.js` asset (built by the locked
esbuild dependency); bundle builders must install the repository's locked npm
dependencies with lifecycle scripts disabled before running `bundle.sh`.

## Protocol and integrity

The authenticated, CSRF-guarded native routes are under
`/api/v2/conversations/{conversation}/encrypted-uploads`:

- `POST /` creates or resumes a client UUID with immutable file metadata.
- `GET /{id}` reads its owner/conversation-pinned recipient and chunk receipts.
- `PUT /{id}/chunks/{index}` transfers at most 1,114,112 ciphertext bytes as
  `application/octet-stream`, with `x-orkestr-ciphertext-sha256`.
- `GET /{id}/chunks/{index}` returns one checksum-verified ciphertext chunk.
- `POST /{id}/complete` pins the exact ordered chunk receipts; it does not
  submit a message or claim that a provider can read the attachment.
- `POST /{id}/attachment` verifies and materializes a provider file, then
  returns the existing `MessageAttachmentReceipt` used by the composer.
- `DELETE /{id}` removes the provider export and the ciphertext session/chunks.

Each chunk contains at most 1 MiB of file data. Its independently age-encrypted
header binds upload UUID, owner, conversation, filename, MIME type, complete file
size, index, chunk size and plaintext SHA-256. Decryption validates every field,
the age authentication tag and the plaintext checksum. Chunk order and count
are fixed by the declared file size and the committed ordered receipts. A
whole-file SHA-256 is computed incrementally when preparing the provider file.

The browser reads `File.slice()` ranges, never `File.arrayBuffer()` for the
complete file. Requests, crypto workspaces and database BLOBs are chunk-bounded;
the Dioxus bridge receives receipts only. After an interrupted transfer the
owner reselects the file. The draft retains only its session UUID in browser
session storage. Already committed chunks are decrypted and compared to the
reselected ranges before being skipped. A lost PUT response retries the same
ciphertext and returns the same receipt. Private browser identities remain in
the existing browser key store.

## Service-readable files and key custody

This preserves native V2's existing server-readable attachment semantics. The
browser encrypts to its enrolled browser recipients **and** the service ingest
recipient. This is not encryption that hides files from the server. The
authenticated attachment operation decrypts one bounded chunk at a time to a
private temporary provider file, checks all bindings, computes the complete
checksum, syncs, and atomically publishes the verified file before issuing its
receipt. Provider plaintext exports remain readable to authorized execution
processes, as with the previous native attachment path. There is no plaintext
HTTP or unencrypted attachment-store fallback in the new composer flow.

Startup atomically provisions `<server-home>/keys/attachment-ingest.age` with
mode 0600. Restarts reuse it; invalid or unreadable existing files fail closed
and are never silently replaced. `ORKESTR_V2_ATTACHMENT_INGEST_IDENTITY_FILE`
can select an existing private identity instead. Identity bytes never enter
Core, API replies, logs or receipts. The loader rejects symlink ancestors,
aliases, hardlinks, non-regular files and unsafe ownership/permissions. State
and export paths are traversed with descriptor-relative no-follow operations;
root-owned sticky ancestors such as `/tmp` are permitted for disposable tests.

Back up the ingest key together with Core, browser-recipient state and provider
exports. Restore the same key before opening old uploads. Losing it prevents
service materialization; browser recipients can still decrypt their stored
chunks. Protect its directory from execution users: a shared service/executor
UID or unrestricted host-root capability is not an isolation boundary. The
service-user/Core-custody rollout must verify this explicitly.

Before publication, a short Core write transaction reauthenticates the live
session and pins the completed receipts while performing the already-prepared
file rename. Revocation/deletion writers cannot commit in that interval.
Materialization and export deletion also share a lifecycle lock. Two concurrent
decrypt/export jobs are permitted; crypto and large writes run outside the
publication transaction. A rejected or dropped server preparation drops its temporary file
and issues no attachment receipt. Process death can leave private temporary
exports; recovery must inspect and remove stale `.<upload UUID>.<nonce>.tmp` files
before reclaiming disk, without touching a running export.

The provider-preparation route has a 15-minute server deadline only for an
authenticated POST with valid conversation/upload UUIDs. Authentication occurs
before granting that deadline or extracting a body. Chunk requests, other
methods and other routes retain their original request deadlines. This is a
bounded allowance for at most one supported-size file, not a global timeout
increase. The browser's encrypted client has no short per-fetch timer and
propagates explicit AbortSignals rather than retrying cancellation.
Aborting a browser wait does not promise deletion of an already verified export;
retry the same upload ID to resolve an uncertain outcome, or use authenticated
DELETE to remove the completed file. Neither operation implicitly sends a message.

Concurrent retries for one upload serialize. A bounded 128-entry in-memory
receipt cache reuses only an unchanged service-owned provider file with the
same completed descriptor and a fresh Core publication-authority check. A
missing/changed file is reconstructed from authenticated ciphertext. Cache
state is deliberately lost on process death; after restart the retained ingest
key and ciphertext provide the reconstruction path, not a cached success
claim. Receipt queries use a covering metadata index so they do not traverse
large ciphertext overflow pages on each chunk/status request.

## Storage and retention

Incomplete sessions expire after a fixed 24 hours, enough for a 1 GB transfer
at 1 Mbps. Expired incomplete ciphertext is lazily removed on the owner's next
new-session creation. The limit is eight open sessions per owner. Completed
files remain until explicitly deleted; completion does not recycle quota.

There is a **4 GiB per-owner worst-case ciphertext reservation budget** across
open and completed uploads. Reservation uses the maximum encrypted chunk size,
including very small declared files, so header-shaped garbage cannot evade
storage accounting. Authenticated deletion releases this reservation and removes
the corresponding plaintext provider export. This budget is not a total disk
limit: provider plaintext copies can add approximately another 4 GiB. SQLite
WAL, free-page high water, checkpoints, backups and rollback copies require
additional capacity. Removing a composer chip does not delete the stored file.

## Validation and remaining release gates

Targeted tests cover decimal limit and limit+1, final chunk arithmetic,
chunk-size enforcement, lost-response retry, process/store reopen and resume,
file reselection mismatch, corrupt ciphertext, foreign owner/conversation,
revoked credentials, encrypted metadata mismatch, provider-file receipt and
atomic publication, partial-file cleanup, publication/revocation serialization,
completed-file quota accounting, key permissions/symlinks/hardlinks, restart key
retention and fail-closed corrupt keys. HTTP tests exercise the registered
guarded router and its 413 request-body limit. Node tests use synthetic bytes
and the maintained age package; the WASM UI is checked separately.

These checks do **not** prove a real browser transferred and submitted a full
1 GB file. Before release, exercise the built UI through the actual proxy with
a generated 1,000,000,000-byte file, observe browser/server peak RSS, interrupt
and resume, verify the provider file and complete SHA-256, and reject limit+1.
Include multi-file quota/deletion, concurrent activity, cancellation/process
death, restart recovery, and a small-file composer regression. Verify proxy
body and request-duration limits accommodate individual chunks and the final
preparation request. Test representative multi-GiB Core/WAL checkpoint,
backup, restore, rollback size and latency against actual disk headroom. An
external object store/file representation may be warranted later; do not infer
backup performance from constant-memory chunk tests. No production deployment
or live configuration change is implied by these source tests.

The ignored manual test
`encrypted_upload_http::tests::large_acceptance::actual_1gb_http_backup_restore_and_provider_reconstruction`
performs an actual 1,000,000,000-byte transfer through the registered HTTP
router, provider-file verification, SQLite online backup, restore from only
ciphertext plus the retained ingest key, and provider reconstruction. It uses
bounded generated chunks and streams both complete-file checksums. Explicitly
enable it using the optimized `--release` test profile and
`--ignored --exact --nocapture --test-threads=1`,
`ORKESTR_V2_RUN_LARGE_UPLOAD_ACCEPTANCE=1`, and
`ORKESTR_V2_LARGE_UPLOAD_SCRATCH` pointing to disposable absolute scratch.
Its execution environment must also provide a disposable `ORKESTR_V2_HOME`;
off-host wrappers must forward these test-only variables explicitly. Run under
the authorized off-host build runner and measure warm execution with
`/usr/bin/time -v`. The test prints a JSON receipt with process peak RSS,
timings, actual provider size/checksum, backup size, and cleanup confirmation;
retain execution receipts privately. It is excluded from ordinary CI because
it writes several GiB. It proves HTTP/store acceptance, not a browser or reverse
proxy transfer. Keep the latter release gates explicit even after it passes.
