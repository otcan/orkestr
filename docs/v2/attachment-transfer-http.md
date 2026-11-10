# Attachment HTTP transfer leaf (not mounted)

The new `v2/apps/server/src/attachment_transfer/` subtree belongs to the HTTP
adapter. Core owns DTOs, integrity validation, schema and persisted byte storage;
UI owns its client, Migration owns the independent archive oracle. Coordinator
owns module/router registration and shared AppState/auth mounting.

The initial source checkpoint contained credential carriage and download
projection helpers only. The published-storage successor is described below. No Store storage substitute, filesystem lookup, network fetch,
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

## Initial dependency request (resolved by the successor below)

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

## Published storage composition

Core `9cd926823` supplies the actual schema38 storage ports and strict transfer
DTOs. This successor composes them on coordinator base `d295da6f7`; the earlier
storage dependency described above is now resolved. No storage implementation
is duplicated here.

Mount seam: register `mod attachment_transfer;`, then nest
`attachment_transfer::router()` under `/api/v2` in the canonical router, inside
the existing shared guard. No AppState field is added. The leaf uses relative
`/conversations/{conversation}` routes: POST `attachment-imports`, GET
`attachment-manifests/{manifest}`, GET its `/export`, and GET/DELETE
`attachments/{manifest}/{reference}`. DELETE requires strict JSON
`{"request_key":"synthetic-removal"}`. Import uses the exact Core DTO: raw octet
arrays, not base64, and a route-local 68 MiB encoded body limit. Coordinator must
preserve that route-local override when merging with the ordinary 40 KiB limit.

Every handler carries the original shared-auth credential into Core. Store
errors map Invalid=400, Unauthorized=401, NotFound=404, Removed=410,
Inert/Conflict=409 and Unavailable=503, with a fixed generic refusal body.
Strict JSON extraction can return 422 for malformed/unknown fields; body-limit
rejection is 413. No untrusted filename is used as a filesystem path.

The synthetic HTTP oracle uses disposable Unix sockets rather than a host TCP
port. It imports, replays, exports and downloads exact binary bytes; checks
corrupt bytes, strict JSON, inert legacy descriptors, foreign scope, removal
without resurrection and revoked replay. A second oracle starts only the
current test executable with a cleared environment and an exact helper filter,
imports over HTTP, kills/reaps that owned child, reopens SQLite and checks exact
persisted bytes and replay. Core's separate transaction-crash windows remain
Core evidence, not claimed by this post-response process kill.

Exact successor validation: eight focused test-harness cases passed (including
the no-op helper entry used by the owned child), zero failed/ignored, against
`d295da6f7` with this leaf privately registered. HTTP tests include the real
shared guard. The command was `v2-cargo test --locked --offline -p
orkestr-v2-server attachment_transfer --lib`. No live API/data/provider or
canonical router activation was executed. Independent review and CI remain
pending.
Strict server library plus test-target Clippy (`--lib --tests -- -D warnings`),
format check and diff check also passed. An initial Clippy warning in the older
credential test was repaired with `expect_err`; no policy or storage behavior
changed for that correction.
All manifest and reference route parameters are nested under the conversation
path and passed together to Core; no global manifest/reference lookup exists.
The shared guard supplies no-store/nosniff on JSON successes, extraction failures
and handler refusals. The raw download helper additionally supplies attachment
disposition and exact raw Content-Length; no byte arrays appear in its body.
Exports return complete bounded JSON octet arrays and metadata; imports/removals
return only Core receipts. No partial export/stream or range response is exposed.

## Reload discovery successor

Core `859b0747e` adds authenticated keyset discovery without a schema change.
The leaf adds GET `/api/v2/conversations/{conversation}/attachment-manifests`
with strict query fields `after_id` (optional nonnil UUID) and `limit` (default
16, accepted range 1–16). Unknown/duplicate/malformed query fields refuse. The
original credential and path conversation go to Core; no query owner is accepted.
The returned canonical owner/conversation on an empty page lets the UI construct
its first target manifest without treating a source archive owner as authority.

Ordering is exclusive lexical UUID order, `next_after_id:null` means end, and
pages are separate authenticated cuts, not one cross-page snapshot. Current
removal tombstones remain visible. The shared guard applies no-store/nosniff.
Core/coordinator own the separate browser-session owner projection; this leaf
does not edit browser.rs or introduce another session/authentication mechanism.

Discovery validation composed unchanged Core `859b0747e` list/DTO source onto the
previous `d295da6f7` disposable composition. All eight focused cases passed with
new empty-page, bounds/query, two-page and revocation assertions in the existing
HTTP oracle. Every HTTP response in that oracle also checks no-store/nosniff.
Strict server library/test Clippy, formatting and diff checks passed. Shared
browser projection and canonical mounting remain coordinator-owned and were
not changed or claimed executed by this leaf; independent review/CI pending.
