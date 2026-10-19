# Beta UI checkpoint

The beta shell exposes Assistant, History, Host resources and Settings for one
configured Codex Deep conversation. Native setup/sign-in, editable page-scoped
drafts, reconnect, canonical history, held inputs, saved thread files, progress,
owner acceptance, Stop and capability-gated steering reuse the existing flows.
Fast, Worker, Memory, timers, external reply controls and project provisioning
are not mounted in this shell. Deferred source remains in the repository.

The shell currently resumes the browser session's conversation. The authenticated
beta capability response must supply the configured conversation before the
window surface is activated. Core owns window DTOs and Runtime owns GET
`/api/v2/beta` and GET/POST `/api/v2/conversations/:id/window`.

Message intake and window admission are distinct. A durable message receipt does
not prove that execution was admitted or started. A failed or uncertain window
request must keep that input visibly queued and retain its immutable retry tuple.
Opening is not active; reconciliation is not permission to restart. No credential,
account, native path or provisioning authority comes from this UI.

This is a source checkpoint. No native/WASM build, browser run or paired-candidate
acceptance is attributed to it. Installation owns the frozen matching build.

The unmounted beta request helper uses only the selected relative capability and
window routes, browser cookies and CSRF for writes. It preserves serialized
request integers verbatim, bounds response bytes and read iterations, and aborts
on caller cancellation. Its six Node transport tests do not validate the pending
Core window DTO or prove server integration. Typed decoding and mounting await
that exact source checkpoint; no admission is inferred from a transport result.
