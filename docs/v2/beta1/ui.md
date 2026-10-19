# Beta UI checkpoint

The beta shell exposes Assistant, History, Host resources and Settings for one
configured Codex Deep conversation. Native setup/sign-in, editable page-scoped
drafts, reconnect, canonical history, held inputs, saved thread files, progress,
owner acceptance, Stop and capability-gated steering reuse the existing flows.
Fast, Worker, Memory, timers, external reply controls and project provisioning
are not mounted in this shell. Deferred source remains in the repository.

After native sign-in or session resume, the shell requires authenticated beta
discovery before mounting chat or history. The browser session's global
conversation is not used as a configured-conversation fallback. Core owns window DTOs and Runtime owns GET
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

Discovery consumes exact Runtime `1b2dc432b` types through the bounded raw-text
bridge. Scope generation and component disposal fence late responses. Unknown
schema, nil conversation, unexpected limits or foreign window scope refuse
mounting. This does not activate window admission; sampled controls grant no
authority. Core `c8beddef8` generation validation is consumed unchanged.
