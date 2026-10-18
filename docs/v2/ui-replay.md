# UI mixed replay

The UI consumes canonical DTO source and the observation fixture verbatim from
core `bf87414fd4d9efe669d627f9d8f493cbf9b6f271`. No backend adapter, migration,
root manifest or lock changes are authored here. Legacy event.json is unchanged.

All supported SSE names decode through ConversationEvent. Before applying an event, the UI
checks variant/schema, positive sequence, exact numeric SSE id, conversation and
snapshot scope. Invalid JSON/variants become resync_required, never message text.
Unknown named events also request resync. Invalid events cannot directly advance
the cursor or mutate messages.

For any supported variant newer than the applied cursor, the UI fetches a
paged snapshot from that cursor into a cloned projection. This avoids skipping
message rows in gaps before metadata. Cursor/projection commit together only when
the completed snapshot's initial canonical watermark covers the event. A snapshot
behind the event requests a full resync; failed fetch retains the prior cursor.
Metadata-only pages can therefore advance the cursor without fabricating text.
Pagination retains its initial watermark; later page watermarks never silently
advance beyond that completed scan. Snapshot scope must remain consistent.

Validation: eighteen Rust tests (seven projection, three replay and eight executable
reconciliation failure/retry cases),
22 Node bridge/synthetic HTTP cases, locked offline WASM build and strict UI Clippy
pass locally. Tests cover legacy JSON roundtrip, mixed sparse journal sequences,
metadata-only watermark advancement, wrong scope/conversation/name/cursor/schema,
unknown variants and missing synthetic marker. Node checks exact canonical fixture
forwarding; it does not validate Rust types or execute the real server/browser.

Fixture metadata remains synthetic. No model success, production run readiness,
Stop, native/device acceptance or OXRM readiness is inferred. Core's durable
fixture adapter and live mixed-stream browser acceptance remain separate gates.

The transport now calls the library's async `reconcile` function directly. Tests
inject deterministic page results into that same function: second-page outage,
validation failure, mixed message/metadata gaps, exactly-once retry presentation,
regressing page watermark, repeated rows, invalid/nonadvancing next cursor, and a
snapshot that cannot yet acknowledge its triggering event. The staged clone is
returned only on complete success; the original projection/cursor stays unchanged
on error. A later page watermark cannot replace the initial scan watermark. The
real Rust bridge decoder is also exercised for malformed-variant resync.

The local commands are wrapper `test --offline --locked -p orkestr-v2-ui --tests`,
`build --offline --locked -p orkestr-v2-ui --no-default-features --features web
--target wasm32-unknown-unknown`, and `clippy --offline --locked -p orkestr-v2-ui
--all-targets -- -D warnings`, plus `node --test v2/apps/ui/tests/*.test.mjs`.
These remain unit/build/bridge evidence; live mixed rendering is a separate CI
gate. No browser was launched and no auth/native/readiness acceptance is added.

Schema 3 cancellation replay consumes only exact contracts paths and fixture from
core `14cc7a8f33c844cc99fccc33bc2e1c04e1264ad1` in a separate provenance commit.
The Rust union match and known SSE names include `fixture_cancellation_requested`.
It uses the same identity/scope/cursor and atomic snapshot reconciliation checks.
`unknown` means outcome unconfirmed; `not_dispatched` means no provider delivery.
Neither means Stopped or successful provider interruption. No cancellation button
or endpoint is added. Tests validate mixed schemas 1/2/3, cancellation metadata
failure/retry, malformed schema/fields/outcome and canonical bridge forwarding.
Compatibility source and unit checks do not establish adapter writes or live
browser cancellation behavior; those gates remain independently reviewed.

Schema 4 consumes exact contracts and fixture from core
`537b7add3106b5089dc7d5188bfcd84ceda52b69` in a separate provenance commit.
`fixture_provider_stopped` validates typed identity, scope, positive provider
sequence and the singleton cancelled receipt through the canonical union.
Only this confirmed fixture acknowledgement is described as a cancelled receipt;
a schema 3 request remains unconfirmed or not dispatched. Ordinary runtime,
cancellation API and Stop remain unavailable. Mixed schema 1/2/3/4 tests exercise
atomic second-page failure, behind-event watermark refusal, retry without skipped
text or duplicate presentation, and malformed metadata resync. Adapter persistence,
independent review and live browser acceptance remain separate gates.

## Production observation compatibility

The UI imports the schema-5 production observation contract from exact Core
`508c5f089d3a162f682e1deaa1b95166eedeedcf`, separately from backend integration.
`provider_observed` uses canonical identity, scope, sequence and payload validation.
It remains metadata: snapshots supply conversation text, and a completed proposal
is shown as awaiting review rather than verified completion. No progress payload,
provider start or control request is activated by this change.

Regression coverage rejects malformed schema/identity/sequence and forbidden
payload fields, and exercises a production observation gap across two snapshot
pages: second-page failure preserves the original projection and cursor; retry
applies text once. Legacy intake serialization remains covered unchanged.
Local validation: 43 Rust UI tests, 28 Node bridge tests, locked offline WASM
build and strict UI Clippy. Live mixed browser/server acceptance remains separate.
