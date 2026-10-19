# Claude cancellation evidence and owned cleanup

The Claude cancellation adapter consumes the original live pump and a Core-issued
`CancelReceipt`. Browser input never supplies a native session, input UUID,
provider handle, lease, or cancellation admission. The existing authenticated
Stop transaction and exact-run mailbox remain the authority boundary.

Every fresh and resumed Claude user frame carries the unique consumed message
UUID. Cancellation targets only that UUID through the fixed native interrupt
request, with `cancel_queued: false`. The channel and owned native descriptor move
once into the cancellation adapter. Core's cancellation fence is checked both
when the broker command is enqueued and before each actual native write suffix.
Partial or uncertain writes cannot restart the request.

An acknowledgement and a terminal are separate evidence. The adapter requires
the exact successful `interrupt:4` response with `turn: stopped`, and a distinct
`error_during_execution` result with `is_error: true`, `terminal_reason:
aborted_streaming`, the original native session, and the original consumed input.
Either order is supported. Idle or spared acknowledgements, tool cancellation,
foreign or replayed identifiers, a second terminal, malformed frames, and local
process exit cannot substitute for that pair.

Existing-turn output buffered while the control is being prepared remains
readable. Its original scope is checked, but it cannot append post-Stop progress.
The adapter drains at most 1,024 bounded frames; the broker retains its stricter
closed telemetry and notice budgets. Only closed nonauthoritative telemetry is
accepted after the matching terminal. Raw provider error content is not retained
as cancellation evidence.

After the pair, the adapter closes the original writer and consumes the owned
child into `RetiringBroker`. It requires the original matching `ReapedBroker`
witness before constructing or persisting `ProviderEvent::Stopped`. A forced
cleanup or a guessed PID cannot create that witness. SQLite Busy or Unavailable
after cleanup retains the exact pending observation and proof for persistence
retry; it never resends the native interrupt.

The ordinary-server leaf has a bounded ten-second observer. Timeout, revocation,
ACK-only output, or missing cleanup proof leaves cancellation unresolved and
quarantines the original authority. The existing shutdown path may conservatively
fence and clean up without waiting for a successful native Stop; local shutdown
must not manufacture Stopped.

After a confirmed Stop, Core alone authorizes a stopped-session successor. Inputs
held at the Stop boundary remain held. A fresh admitted input can resume only
after the exact prior tree has been reaped. Accepted completion uses the distinct
accepted-session grant. Historical receipts remain replayable without dispatching
another interrupt or mutating a successor.

## Validation surfaces

Runtime tests use a fixed synthetic native executable and ordinary SQLite Store.
They cover correlated ACK/terminal order, foreign and duplicate terminal refusal,
ACK-only and exit-only negatives, buffered progress, actual zero-byte and partial
native writes followed by revocation, original host process disappearance before
Cancelled, and persistence replay after a real SQLite writer lock.

`v2/tests/owned_claude_stop_http.py` exercises the mounted ordinary server through
cookie/Origin/CSRF authentication with a synthetic executable. It covers a single
Stop intent after progress advances, durable held input, inert receipt replay,
fresh post-Stop input, and ACK-only, foreign-terminal, and revoked-session
negatives. This fixture grants no evidence about a real provider until the exact
composed server and its private provider package are reviewed and run separately.
