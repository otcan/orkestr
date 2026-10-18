# Browser-session UI checkpoint

The web client consumes the browser contract published by core at
`03f0649fb5fe21dc9677d12e3dabcb72a6a729cb`; see
[browser-session-v1.md](browser-session-v1.md).

Startup resumes through `GET /api/v2/browser/session`. Sign-in posts credentials
to that endpoint. The client retains only the returned CSRF value and global
conversation ID in page memory. Relative fetches use `credentials: same-origin`;
the browser owns the HttpOnly cookie. Writes send `x-orkestr-csrf`. No browser
Bearer header, token URL, localStorage or persistent JavaScript credential store
is used. Streaming fetch also uses the same-origin cookie.

Sign-out sends DELETE with CSRF and reports revocation only after success.
An uncertain response remains visibly unconfirmed. A 401 returns to sign-in;
unsent drafts remain in page memory. Reloading the page discards those drafts.

Local checks: seven Rust projection tests, fifteen synthetic Node request/stream
tests, locked offline WASM build and UI Clippy with warnings denied passed.
Bridge tests inspect fetch options and synthetic responses; they do not exercise
a browser cookie jar, actual Origin enforcement or the live server.

Independent security review and real browser boot/login/resume/write/logout
acceptance remain pending. Native WebView transport, device authentication,
credential storage, keyboard/accessibility and unsigned simulator build remain
unverified. Runtime/Stop and local OXRM readiness are not inferred from intake.
