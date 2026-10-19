# Selected service broker failure diagnostics

The selected Codex service reports failures using reserved exit codes. This is
negative evidence only: it does not authorize dispatch, acceptance, Stop,
retirement, a new window, or replacement. All existing frame and terminal guards
still refuse. Native and broker stderr handling remains unchanged.

Only `codex_service.broker` enables the extra observation. The existing standalone
Codex, Worker and Claude launchers retain their prior failure exit behavior.
Shared broker manifests pin the same updated protocol and transport files.

On an exception, before `Pump.run` closes pipes or invokes `reap_owned`, the pump
samples its original Popen child with `waitid(WEXITED|WNOHANG|WNOWAIT)`. This is the
outer containment child (prlimit becomes bwrap), not the namespace-local native
PID. The sample does not reap it or transfer cleanup authority. Its state is:

| Value | Original containment child observation |
| --- | --- |
| 0 | No child was launched |
| 1 | No exit was observed at this instant |
| 2 | Exited with status zero |
| 3 | Exited with a nonzero status |
| 4 | Terminated by a signal |
| 5 | Unknown or unavailable observation |

The exit code is `80 + (Failure - 1) * 6 + state`, where `Failure` is the closed
`protocol.Failure` enumeration. All combinations occupy 80–217. Neither success
zero nor the existing cleanup-proof exit 73 can be produced by this mapping.
Exit 73 still requires parent EOF, an original child and successful owned reap.
Failures before a pump exists or outside the diagnostic range retain exit 2.

The cause identifiers distinguish framing, provider EOF, transport, known late
turn notifications, wrong-thread/retired-turn/current-turn guards, unexpected
responses and response correlation. Known late methods have separate identifiers;
unknown method names, exception strings, IDs, paths, prompts and provider bytes
are never encoded. `UNEXPECTED_RESPONSE` means there was no pending request;
`LATE_*` means a committed turn was already terminal. Other unknown exceptions
map to `INTERNAL`. These are observations of refusal guards, not inferred causes.

Runtime logs the original broker's numeric code/signal from its existing scoped
WNOWAIT liveness observation before quarantine. An unavailable observation has a
separate static label and the existing closed containment-error enum. Quarantine,
reconciliation, native process limits, protocol limits and budgets are unchanged.

A missing or unknown diagnostic is inconclusive. Even provider EOF with an
unexited outer containment child cannot prove that the inner native process was
alive. Cleanup can follow either a protocol refusal or a native exit, so sampled
process-disappearance order alone cannot distinguish these cases. This change
does not establish the cause of any historical accepted-idle failure.
