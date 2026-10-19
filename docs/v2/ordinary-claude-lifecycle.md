# Ordinary Claude accepted continuation

The private `provider: "claude"` configuration now supports another turn after
explicit owner acceptance, and a controlled restart after graceful retirement.
The HTTP admission and acceptance DTOs do not gain provider, account, launcher,
native-session or dispatch-authority fields. Default execution stays disabled.

Each accepted turn uses a new owned broker and native process. Its native Claude
session UUID stays unchanged. The previous exact transport is consumed into
`RetiringBroker`; replacement requires the existing exit73/ECHILD tree witness
and retained-resource barrier. A projection, PID, ACK, timeout or local process
exit cannot produce that witness. Core then issues an exact one-use accepted
metadata grant. Setup failure or uncertain attachment cannot retry the grant.

The Runtime launcher derives the fixed `claude-resume-v1` FD4 bootstrap from that
grant. FD3 is a new sole-writer handoff. Neither descriptor is reused. A resumed
native receives `--resume` with the existing UUID, never `--continue` or a fork.
Initialization ACK still reserves an unobserved identity; the matching real
`system/init` must commit before Started or output on every resumed run.

A resumed input's UUID is the consumed Core message ID. The closed frame
validator requires exact equality with the wrapper's message ID. Both broker
and Runtime reject assistant/result frames without that exact
`user_message_uuid`; a plural field, if present, must contain only this input.
Old or mixed input evidence is quarantined, including an unseen historical
frame on a fresh reader. Producers that omit this join key remain incompatible
with this strict resumed-output path; no fallback relabels their output.

Inputs admitted during work stay in Core's ordered queue until owner acceptance.
No native replacement is opened until eligible input exists. Held input stays
held across acceptance, retirement and restart. Duplicate intake and historical
acceptance replay do not redispatch an input or alter a successor run. Controlled
restart requires Core's exact graceful-retirement provenance and a current
machine session; unresolved, unaccepted, expired-only or unknown history is
refused. Restart opens no native process merely because accepted history exists.

## Validation and limits

`owned_claude_lifecycle_http.py` drives the ordinary default-feature executable
against a fixed synthetic native. It checks two turns with one durable session
and two exact host process identities, accepted restart with a new supervisor
incarnation, inert receipt replay, duplicate conservation, old-output refusal,
and shutdown that holds pending input without inventing Stopped. The external
process oracle resolves namespace locators within the owned server tree and
checks each host PID/start identity disappears. The synthetic transcript contains
fixture data only. These checks do not access an actual account or provider.

The existing first-turn HTTP suite continues to prove requested-versus-observed
identity, refusal, revoked-session and budget behavior. Its queue-before-accept
assertions now live in the continuation suite because accepted queued input is
intentionally eligible for the next sealed turn.

Native Stop and Steer remain unavailable. The official SDK's interrupt operation
sends a control request and awaits its response; that ACK alone cannot establish
an interrupted terminal outcome. No corresponding pinned-native terminal proof
has been accepted here. Budget/shutdown fences durably and reaps owned resources,
leaving cancellation unknown and pending inputs held. Such history cannot resume
automatically. Claude Worker execution and extended per-run leases remain out
of scope; the existing maximum 45-second private run budget is unchanged.

The pinned CLI compatibility check used Claude Code 2.1.295 `--help` under a
fresh empty home without credentials or inference. The explicit session-resume
behavior agrees with [official session documentation](https://code.claude.com/docs/en/agent-sdk/sessions).
The distinction between interrupt response and terminal evidence follows the
[SDK control implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).
These references do not replace a separately reviewed real resumed-turn probe.

Run the synthetic executable checks with:

```sh
cargo test --locked -p orkestr-v2-server --test owned_claude_lifecycle_http
cargo test --locked -p orkestr-v2-server --test owned_claude_http
cargo test --locked -p orkestr-runtime --lib claude
```

Use a fresh isolated `ORKESTR_V2_HOME` for native Runtime tests, as required by
the V2 test harness. No test may use production state or a real provider.
