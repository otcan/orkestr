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
Runtime consumes the old opaque issuer after transferring the exact same-child
lease fence. Core then returns its current issuer; the server neither clones nor
reconstructs authority. This transition holds the same run scheduling lock as
HTTP and native polling. A queued HTTP selection owns only a mailbox handle and
cannot retain an obsolete issuer. A failed transition owns child cleanup and
leaves steering unavailable. The persistent broker's 128-request limit also
survives accepted turns and successful lease renewal. Exhaustion disables
steering and preserves subsequent explicit input as queued ordinary work.

The process regression uses actual HTTP, SQLite, the configured broker and its
sole native writer with a synthetic native peer. Nine cases cover delivery and
immutable replay, authentication/scope, ordered fallback, missing and foreign
acknowledgements, Stop, browser revocation, same-turn delivery after actual lease
renewal, and exhaustion across two accepted turns. Missing
acknowledgement is bounded to two seconds and causes owned-child cleanup while
retaining uncertainty. The pre-existing Stop oracle now permits the new running
steering capability and requires both controls disabled after cancellation intent.
It still requires a genuine interrupted terminal before reporting cancellation.
The broker reaps its native child before closing its own output pipe; Runtime
then observes that EOF and updates the execution projection on a separate poll.
The uncertainty cases measure controls becoming unavailable within one second
of observed native cleanup, including the complete HTTP response time. Reports
retain sampled phases and capabilities on success or failure. This convergence
bound does not replace the separate Stop-admission performance gate.

These tests do not qualify a real provider, a browser artifact, a release
candidate, or a production cutover. Actual provider and matching UI acceptance
remain separate release requirements.
