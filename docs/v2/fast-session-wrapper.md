# Retained Fast session wrapper

The server's `fast_execution` module owns one Codex-backed Fast native session.
`PreparingFast` accepts only a Core-issued Fast metadata grant, and `ReadyFast`
consumes the canonical non-inbox `FastAdmissionInput`. These objects expose no
constructor for a provider capability, source text, role or native identity.

`LiveFast` retains the exact transport and opaque Core renewal issuer privately:

- `run_id`, `pending`, `renewal_quiescent` and `lease_deadline_ms` expose scheduling
  observations. A consumed or failed wrapper has no executable transport.
- `tick` persists the exact pending observation before further native polling.
- `renew` transfers the same child and turn through Runtime's sealed lease port.
  The ordinary factory must serialize it with polling and Stop, heartbeat only
  live authority, and enforce a finite configured run/idle budget. Renewal does
  not create an input, accept output or change the factory's hard deadline.
- `continue_accepted(self, credential, input)` requires current exact Fast owner
  acceptance, the same binding and its next generation. Fresh canonical admission
  then feeds Runtime's Fast-only same-child continuation. Replay and uncertainty
  consume the old wrapper and never issue another native start.
- `stopping(self, PendingControl)` uses the existing typed cancellation path and
  retains the native child only for verified retirement. An ACK is progress;
  only a correlated durable Stopped observation permits its reap witness.
- `retire_accepted(self, credential)` rechecks exact accepted state and returns
  Runtime's negative cleanup handle. The factory must await its `ReapedBroker`
  and retained-resource release before Core graceful retirement or new setup.

The wrapper does not mount routes, choose sources, grant owner acceptance,
consume Deep inbox entries, schedule Workers, or silently revive expired state.
Those factory decisions use Core's separate typed ports and fixed configuration.
Recovery must use a separate Fast supervisor context; retiring one role cannot
justify restarting another role's native session.

`fast_persistent_execution` exercises the actual broker/FD transport and ordinary
Store with synthetic native processes: accepted same-child reuse, lease transfer,
verified reap and metadata resume, real Stop, ACK-only uncertainty, revocation
and refusal before owner acceptance. The existing one-shot Fast regression stays
in place. Run with an isolated `ORKESTR_V2_HOME`; optional
`ORKESTR_V2_TEST_EVIDENCE` names an existing private output directory for raw
synthetic traces and selected read-only ledger evidence. Failed fixtures retain
their disposable directory for diagnosis. This is process qualification, not a
claim of mounted HTTP, browser, real-provider or full-release readiness.
