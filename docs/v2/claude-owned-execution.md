# Owned first-turn Claude execution

`orkestr_runtime::execution::{PreparingClaude, ReadyClaude, ClaudePump}` is the
ordinary-store first-turn composition. Trusted server configuration chooses the
immutable launcher and its selected subscription internally; `system/init` is
session metadata and does not prove authentication.

`PreparingClaude::open_retained` consumes Core's metadata grant and retains the
server's opaque capacity/directory resource until child reap. Bounded `poll`
validates the broker response and native UUID through ClaudeRpc; async `confirm`
consumes Core's exact setup grant. `ReadyClaude::attach` consumes a fresh Core
`ConsumedProviderDispatch` and transfers the same owned process and actual writer.
No caller-supplied JSON is execution authority.

`ClaudePump::flush` sends the sealed broker preparation only. `step` waits for
BrokerPrepared outside SQLite, then writes each bounded native-stdin suffix under
Core's current execution fence. Failed/uncertain writes quarantine without retry.
Output passes ClaudeRpc before durable Started/Progress/Failed/CompletedProposal
mapping. A failure notice is not a terminal result; completion requires
`terminal_result_seen`. The existing pending cursor retains exact sequence/body
through transient store failure before reading further output. Progress text uses
Core's removable payload adapter; completion remains AwaitingAcceptance.

There is no continuation or Claude native interrupt API in this checkpoint.
Fresh-process resume requires the separately issued accepted-session metadata
grant and reviewed resume correlation. EOF never implies successful cancellation.
The ordinary server factory owner must register this API explicitly; no default
configuration or real-provider activation is enabled here.

Validation uses an owned synthetic native executable behind the actual Python
Claude broker, FD handoff and ordinary Store. It proves success/progress and
failed-result transitions, not subscription entitlement or live-provider behavior.

The unregistered `server/src/claude_execution` factory supplies opaque
PreparingClaudeExecution / ReadyClaudeExecution / LiveClaudeExecution wrappers.
It retains the bound Store and owned Authority; parent-driven `tick` pumps durable
observations and Drop quarantines the owned process without asserting cancellation.
The shared server factory owner can register this narrow module after source
review. Its separate executable integration tests exercise the same success and
failure flows through the wrapper; they do not invoke an HTTP route or real model.
