# Worker discovery controller handoff

The new `apps/server/src/worker_discovery.rs` implements browser-only discovery against Core contract `d179601114d53ac4f0585cd4d30029d0ba8f9661`.

Composition owner registration (not included in this change):

```rust
mod worker_discovery;
// In the existing authenticated router:
.route("/api/v2/conversations/{id}/workers", get(worker_discovery::list))
```

The composition must supply its existing supervisor-bound `AppState.execution_store`. Missing binding returns 503; there is no fallback to an unbound Store. The handler uses the existing browser Host/cookie namespace helper and rechecks the exact credential through Core's read transaction. It accepts only `after` (non-nil RunId) and `limit` (1..100, default 25), rejects duplicate/unknown fields, validates the returned page/scope/exclusive cursor, and emits `Cache-Control: no-store`. It never derives Worker readiness or control authority from discovery.

## Bounded validation

The isolated implementation branch starts at integration `175f297c514b1a43f130f889c2b648a1a5c7e28d`; that base does not yet include the discovery Store method. Validation therefore used a disposable full export of exact Core `d179601114d53ac4f0585cd4d30029d0ba8f9661`, its unchanged committed lockfile, these two new source files, and the existing integration browser helper. Private composition glue supplied the existing `execution_store` field/builder plus module registration. No dependency resolution or shared source edit is part of this handoff.

The authored controller test passed: real ordinary Store setup, current browser credential, empty canonical page, invalid/duplicate/unknown query cases, wrong Host, Bearer rejection, missing conversation, absent bound context, and revoked-auth precedence over invalid query. This invokes the real handler/extractor directly; it is not an HTTP listener or mounted-browser acceptance claim.

Separately, the unchanged Core populated discovery test passed, verifying actual Worker parent/source identities, exclusive pagination, full snapshot equality after reads, parent Stop disposition, and revoked/foreign credentials. That is independently executed Core-authored evidence, not independently authored lineage acceptance. Populated controller HTTP composition and browser pairing remain pending registration.
