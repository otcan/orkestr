# UI mixed replay

The UI consumes canonical DTO source and the observation fixture verbatim from
core `bf87414fd4d9efe669d627f9d8f493cbf9b6f271`. No backend adapter, migration,
root manifest or lock changes are authored here. Legacy event.json is unchanged.

Both SSE names decode through ConversationEvent. Before applying an event, the UI
checks variant/schema, positive sequence, exact numeric SSE id, conversation and
snapshot scope. Invalid JSON/variants become resync_required, never message text.
Unknown named events also request resync. Invalid events cannot directly advance
the cursor or mutate messages.

For either supported variant newer than the applied cursor, the UI fetches a
paged snapshot from that cursor into a cloned projection. This avoids skipping
message rows in gaps before metadata. Cursor/projection commit together only when
the completed snapshot's initial canonical watermark covers the event. A snapshot
behind the event requests a full resync; failed fetch retains the prior cursor.
Metadata-only pages can therefore advance the cursor without fabricating text.
Pagination retains its initial watermark; later page watermarks never silently
advance beyond that completed scan. Snapshot scope must remain consistent.

Validation: ten Rust tests (seven existing projection plus three replay cases),
22 Node bridge/synthetic HTTP cases, locked offline WASM build and strict UI Clippy
pass locally. Tests cover legacy JSON roundtrip, mixed sparse journal sequences,
metadata-only watermark advancement, wrong scope/conversation/name/cursor/schema,
unknown variants and missing synthetic marker. Node checks exact canonical fixture
forwarding; it does not validate Rust types or execute the real server/browser.

Fixture metadata remains synthetic. No model success, production run readiness,
Stop, native/device acceptance or OXRM readiness is inferred. Core's durable
fixture adapter and live mixed-stream browser acceptance remain separate gates.
