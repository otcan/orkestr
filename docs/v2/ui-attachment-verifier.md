# Attachment client verifier checkpoint

Compatibility source: Core `9788ef14d0d86ecdaa5dde14522761194064cfb4`,
`contracts/src/attachments.rs` and pure Store `attachment_integrity.rs`.

New isolated modules under `apps/ui/src/attachments/` consume the JSON shape
without changing shared DTOs or dependencies. `referenceFor` rejects invalid
metadata, duplicate UUID identities, foreign owner/conversation/manifest and
missing references. Limits match the pinned ABI: 128 references, 16 MiB aggregate,
UTF-8 basename and restricted media type, lowercase raw-byte SHA-256. Optional
message identity is validated but is not used as read authority.

`verifyBytes` accepts a supplied reader, not a URL. It uses one preallocated destination bounded by the selected immutable length,
checks every chunk before copying, requires exact final length,
hashes raw bytes with Web Crypto, and checks the caller's current scope before
and after asynchronous reads/hash completion. It cancels the reader on every
exit. A 65,536-read budget (including the final done read) refuses empty/chunk
floods independently of byte length. Extremely fragmented valid streams can be
refused; the client never retains one object per chunk. This work bound does not
replace the future transport timeout/abort requirement. Removed metadata with no reader yields a tombstone; supplied removed bytes
are refused. Presentation descriptors retain filename/size and distinguish
`File removed` from `Not downloaded`; neither enables save.

This is a pure, unmounted client boundary. No endpoint, fetch, redirect handling,
object URL, file save, storage import/export or authority is implemented. The
future transport must bind authenticated manifest retrieval, reject redirects and
encoded representations per the eventual registered ABI, own an AbortController
for immediate logout/navigation cancellation and recheck scope at save time.
A current-scope callback fences completed reads; it cannot interrupt an otherwise
hung reader itself. Its generation must change on owner/session/selection changes.
Metadata presentation must use text nodes, never HTML. Integrity against a
manifest does not independently establish provenance.

Validation: `node --test v2/apps/ui/src/attachments/*.test.mjs` passes 15 tests,
including empty/binary content, corruption/truncation/oversize, aggregate/count
limits, the full 16 MiB boundary, tombstones, foreign scope/reference, and delayed
read/hash scope changes, zero-byte and one-byte chunk flood refusal, and
copying from reused mutable chunks. Node syntax and diff checks pass. No browser, real
attachment, download, WASM build, backend roundtrip or mounted acceptance is
claimed. Core persistence and Migration's independent oracle remain separate.
