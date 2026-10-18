# Worker discovery read boundary

`Store::worker_executions_authenticated(credential, conversation, after, limit)`
returns `WorkerExecutionPage`. The exact current browser credential, owner scope
and bound supervisor are authenticated in the same read transaction as the rows.
No native identity, private context, lease, locator or capability is serialized.

The page contains only durable Worker runs in this supervisor context and exact
conversation, including historical incarnations. Each row carries its canonical
parent run/session and immutable source MessageId/EventId from the durable
Worker delegation. Role is always Worker; state is the stored RunState, not a
process-health inference. Blocked or old-incarnation rows require reconciliation;
`current_incarnation` means only incarnation identity, never recovery eligibility.

Limit is 1..100. UUID lexical keyset ordering and an exclusive `after` RunId
provide bounded fresh pages; `next_after` signals another page. Pages are not a
stable export cut. Conversation revision and server observation time identify
this read. The consumer must retain selection/auth generation fencing and fetch
exact-run status for controls; discovery issues no authority. Unknown scope,
revocation, expired supervisor and unbound handles refuse. Routes remain owned
by server composition; this checkpoint does not register an HTTP endpoint.
