# Draft attachments and inline previews

On coarse-pointer devices, Return inserts a newline; use Send or Ctrl/Cmd+Enter
to submit. IME composition never submits, and Return in the pasted attachment
filename does not submit the outer form. Preview layout follows viewport resize,
includes all safe-area insets and returns focus to the latest connected trigger.
Automated keyboard/focus checks do not replace physical iOS/Android qualification.

File selection or drop starts browser age encryption immediately. The single-file
upload pump bounds memory/CPU on mobile; it never falls back to plaintext multipart.
Pasted text uses the same pipeline, with a filename and a 1 MiB text-editor limit.
Per-file upload limit remains 25 MiB, at most 20 selected files. Upload does not
dispatch an agent turn. Send is blocked until every selected attachment is ready.
The browser sends opaque upload session IDs. Server-owned paths are resolved only
after checking the thread owner, readiness, expiry, file existence and key status.

## Persistence and removal

Ready drafts retain ordinary server-side plaintext for up to 24 hours by default
(`ORKESTR_INBOUND_UPLOAD_PLAINTEXT_LEASE_MS`). This is transport encryption, not an
at-rest encryption requirement. Pending ciphertext and processing leases retain
their own shorter expiry/resource policies. Ready drafts count against owner/global
capacity, avoiding unbounded eager-upload storage. Claimed files use ordinary
message attachment retention; the draft sweeper cannot delete them.

The message writer serializes claims with cancellation and expiry using the existing
cross-process upload mutation lock. A durable `claiming` intent records the target
message before append. On success it becomes `claimed`; restart reconciliation
checks the message repository to finish or release the claim. A Send idempotency key
returns the same message; changing the text/attachment set with that key conflicts.
No physical file move occurs during Send. One invalid attachment rejects the entire
set before any message append. Cancellation fences late processing publication.

Session IDs—not file contents or keys—are remembered in sessionStorage per thread.
Within the tab, switching threads preserves each upload queue. Reload recovers ready
drafts and can retry already-quarantined bytes without reselecting a file. Interrupted
uploads whose original File is unavailable require removal and reselection. Browser
tab closure/background suspension does not promise automatic background uploading.
No automatic Send occurs after reconnect. Logout clears in-memory files and previews.

## Previews

Desktop uses a resizable side panel; mobile uses a full-screen, keyboard-accessible
panel with Back/Close, focus restoration, touch-sized controls and safe-area padding.
Text is rendered literally, including HTML/SVG. Preview never executes uploaded code.
Only the first 256 KiB of text is rendered. A dedicated module Web Worker performs
archive listing and selected-entry decoding, with a five-second termination budget.

Supported: UTF-8 text; ZIP stored/deflate entries; basic regular-file/directory TAR;
GZIP text; TAR.GZ/TGZ. Limits: 25 MiB input, 1,000 archive entries, 32 MiB declared/
actual expanded content, 2 MiB per selected entry, bounded expansion ratio. ZIP CRC
and TAR header checksums are checked. No disk extraction, links, devices, traversal,
duplicate paths, nested archive expansion, ZIP64, multipart/password-protected ZIP,
PAX/GNU extended TAR records, RAR or 7z previews. Unsupported types remain download-only.
Native DecompressionStream must support the compression format; otherwise preview
fails visibly. Phone Safari/Android device qualification is a separate release gate.

Ordinary stored attachments are served through authenticated, no-store, age-encrypted
preview streams to verified owner recipients. Existing encrypted outbound artifacts
retain their download/reissue contract. Every endpoint resolves IDs server-side.
Preview streams have a 25 MiB source cap, global concurrency two and a 30-second
stream lifetime. Browser reads are byte-bounded and aborted when the panel closes.

## Controls and rollback

The following UI capability flags default on and accept `0`/`false`/`off`:

- `ORKESTR_EAGER_UPLOADS_ENABLED`: pause new eager uploads; ready drafts still send.
- `ORKESTR_PASTED_ATTACHMENTS_ENABLED`: hide the pasted-content editor.
- `ORKESTR_TEXT_PREVIEW_ENABLED`: disable plain-text viewer parsing.
- `ORKESTR_ARCHIVE_PREVIEW_ENABLED`: disable archive viewer parsing.

These are rollout controls, not authorization boundaries. Required inbound encryption
remains authoritative. Feature disable must not disable cleanup, claims, or existing
encrypted downloads. Do not roll back to binaries without claim-aware cleanup while
claimed records exist: the first supported rollback is feature disable on a compatible
binary. Back up metadata and prove compatibility before any older-binary rollback.

Existing upload transition/latency metrics remain; `orkestr_draft_attachment_claims_total`
counts committed claims with bounded outcome labels. `orkestr_attachment_preview_total`
counts completed/rejected/busy previews; `orkestr_draft_attachment_cleanup_total`
counts cleanup failures. Never add names, pasted content,
raw keys, owner/thread/session IDs to metric labels. Monitor upload retry/failure rates,
draft storage/quota pressure and cleanup failures during canary rollout. No production
deployment is implied by building this feature.
