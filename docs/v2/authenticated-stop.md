# Current-session Stop boundary

Browser composition calls the supervisor-bound ordinary Store method
`stop_execution_authenticated(credential, conversation, input)`. Pass the exact
original browser namespaced credential from trusted cookie parsing, not a JSON
owner, machine token alias, or a newly issued substitute. Existing
`ExecutionControlRequest` and `ExecutionStopReceipt` remain unchanged.

The method resolves the owner, then rechecks the original credential hash,
owner and expiry inside BEGIN IMMEDIATE, before cancellation receipt lookup or
fresh writes. Logout committed before that transaction therefore refuses both
fresh Stop and historical replay. Supervisor authentication remains independently
required. Origin/Host/CSRF enforcement stays with HTTP composition. Existing
`stop_execution(owner, ...)` is a trusted internal API, not browser authorization.

No control is sent before the durable cancellation receipt. The issued control
purpose/fence remains separate from execution and does not confirm interruption.
Opt-in `ProductionCheckpoint::StopAfterAuthentication` pauses before the write
transaction so independent tests can commit logout, remove their owned marker,
and verify refusal with unchanged execution ledger. It issues no authority and
is never armed by normal server startup.
