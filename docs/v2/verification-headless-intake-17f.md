# Hosted intake oracle review

Reviewed exact UI `17f0e798f335971d8fe47eb6f60a360db7697f7a`. No bounded source blocker found. Independently exported the unchanged helper, tests, fixtures and runner from Git; Node helper tests passed 8/8 and runner syntax passed. No browser, build, provider or hosted execution was performed.

The response waiter is registered before typing/Send and matches the exact conversation POST. Fresh 202 and accepted receipt are required, followed by an authenticated same-conversation/global-scope snapshot with exactly one message matching receipt identity, positive sequence, owner actor and exact text. The watermark must cover the receipt. Missing or duplicate admissions, wrong identity/text/scope and insufficient watermark are negative tests. Reload rendering, HttpOnly/Strict cookie checks, missing-CSRF rejection, logout/reload and absence of machine Authorization remain checked. This strengthens durable evidence instead of requiring a transient status sentence; no timeout increase or retry was introduced.

Failure observations retain at most 40 same-origin API route/status entries, normalized UUID paths, stage and DOM/page-error counts. Added diagnostics do not record headers, credentials, request values, response bodies or server logs. The controlled synthetic inputs remain part of assertion failure output; this is a CI-only disposable runner, not a diagnostic for real user state.

The shared Send/history status overwrite is a source-supported hypothesis only. The original hosted run had no matching DOM/network capture, and neither this source review nor the Node tests establish its historical cause or hosted success. Exact-head hosted/browser qualification remains pending.
