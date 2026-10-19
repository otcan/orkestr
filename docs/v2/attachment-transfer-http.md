# Attachment HTTP transfer leaf (not mounted)

The new `v2/apps/server/src/attachment_transfer/` subtree belongs to the HTTP
adapter. Core owns DTOs, integrity validation, schema and persisted byte storage;
UI owns its client, Migration owns the independent archive oracle. Coordinator
owns module/router registration and shared AppState/auth mounting.

This source checkpoint contains credential carriage and download projection
helpers only. No Store storage substitute, filesystem lookup, network fetch,
shared router edit or active endpoint is introduced.

`authority::credential` first calls the shared owner policy, then preserves the
exact original stored browser credential or machine Bearer token for Core's
transaction-time reauthentication. Duplicate machine Authorization headers
refuse. An owner ID from this preliminary check cannot replace current
credential validation inside Store. Shared browser Origin/Host/CSRF protections
must enclose future mounted routes, including import and removal.

`download::response` accepts a structurally valid available reference and bounded
bytes retrieved by a future authenticated Store port. It verifies raw-byte
SHA256 and length before constructing 200, with exact Content-Length,
manifest Content-Type, attachment disposition, private/no-store and nosniff.
The ASCII fallback filename is fixed; the UTF8 filename uses percent encoding,
including quotes/apostrophes/percent. There is no redirect or content encoding.
This helper does not authorize retrieval or turn a UUID into authority.

## Exact dependency still required from Core

Published integrity contract `9788ef14d` is a validator, explicitly not persisted
storage or authenticated export/import/download. The following ABI is requested,
not claimed implemented:

- Original-credential authenticated manifest/export snapshot, scoped by target
  conversation and manifest, preserving available bytes and removed references.
- Atomic authenticated import DTO/receipt with fresh target IDs, exact complete
  reference mapping, immutable replay key/provenance and no restoration of
  removed content on replay. Source owner IDs are metadata, not target authority.
- Original-credential raw download returning available bytes/reference, removed
  (410), or absent/foreign (404); stale credential (401). Other Store errors need
  stable typed mapping. No response may leak foreign metadata.
- Exact byte encoding and body-size cap: raw/aggregate contract cap is 16 MiB;
  the enclosing JSON limit must account for the chosen encoding and metadata.
  Do not inherit the ordinary small-message limit or allocate an unbounded body.
- Explicit inert handling of out-of-cap/missing legacy references. Never accept
  client paths, fetch URLs, inline settings, browser profiles or provider input.

Proposed route family is conversation-scoped export/import plus the download
shape in Core's integrity document. No route URI/DTO is frozen by this leaf.
Core schema38 and exact storage source/ports are prerequisites for routes.rs,
HTTP/process tests and an actual owner-scoped byte roundtrip. Those tests remain
unexecuted; pure projection tests are not vertical acceptance. No actual data
import, live API, browser operation or production authority is exercised.

## Executed source checks

A disposable composition of coordinator base `098191720` with unchanged Core
DTO source `9788ef14d` and this unregistered leaf passed five focused library
tests: raw-body/header projection (three), and actual disposable Store-backed
shared machine/browser credential and revocation checks (two). Strict server
library Clippy passed. Commands used the assigned wrapper with `--locked
--offline`: `test -p orkestr-v2-server attachment_transfer --lib` and
`clippy -p orkestr-v2-server --lib -- -D warnings`.

The earlier `af0b3b338` composition failed compilation because shared Worker
configuration lacked `reaps`; that original failure remains distinct from the
successful corrected-base check. No authenticated storage route, HTTP/process
roundtrip or import/export execution has been tested. CI remains pending.
