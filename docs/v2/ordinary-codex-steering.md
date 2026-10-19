# Ordinary Codex steering

The ordinary configured server exposes browser-authenticated
`POST /api/v2/conversations/{conversation}/steer` and
`GET /api/v2/conversations/{conversation}/steering/{request_key}`. Submission
requires the existing Origin and CSRF guards and the exact stable run control
precondition. Neither endpoint accepts a native turn identifier or provider
authority. Core checks the browser and configured machine session again inside
the admission transaction.

The owned run retains its opaque Core steering issuer, binds it to the actual
native turn observed by Runtime, and shares the Stop scheduling lock with HTTP.
A one-item mailbox transfers only a consumed steering capability. Core commits
`delivery_unknown` before the mailbox can expose native I/O. Lost responses,
closed mailboxes, timeout and restart cannot convert that input back into an
ordinary queued turn. An exact request replay returns its original receipt;
changing its text conflicts. Native acknowledgement is distinct from completion
or owner acceptance.

Older ordinary inbox input preserves FIFO order and disables advertised steering.
Submitting an explicit steering request in that period returns `queued_ordered`.
Unsupported periods return `queued_unsupported`. These dispositions retain the
input for ordinary execution after the preceding turn is explicitly accepted.
The initial composition retires its immutable issuer at the first lease renewal;
inference continues, but subsequent steering is honestly queued. A sealed issuer
refresh port is required before steering can span that boundary.

The process regression uses actual HTTP, SQLite, the configured broker and its
sole native writer with a synthetic native peer. Eight cases cover delivery and
immutable replay, authentication/scope, ordered fallback, missing and foreign
acknowledgements, Stop, browser revocation, and lease-renewal fallback. Missing
acknowledgement is bounded to two seconds and causes owned-child cleanup while
retaining uncertainty. The pre-existing Stop oracle now permits the new running
steering capability and requires both controls disabled after cancellation intent.
It still requires a genuine interrupted terminal before reporting cancellation.

These tests do not qualify a real provider, a browser artifact, a release
candidate, or a production cutover. The persistent broker's 128-request bound
must also be reflected by the server across accepted turns before the full
steering release gate is closed.
