# Explicit owner acceptance (contract checkpoint)

Schema 9 `execution_accepted` is a separate canonical owner decision. Existing
schema 1–8 serialized variants remain unchanged. `ExecutionAcceptanceRequest`
identifies the run, exact durable completion EventId, expected conversation
revision and idempotency key. Owner and conversation come from the authenticated
server context, never a provider-supplied identity. Browser writes require the
existing cookie, CSRF and Origin protections. No HTTP route is activated here.

The proposed Store operation is `accept_execution(owner, conversation, request)`
returning `ExecutionAcceptanceReceipt`. This is an owner operation, not a
RuntimeStore provider method. The adapter must authenticate owner/scope before
looking up a historical decision. Identical committed replay returns its original
receipt without changing the current binding, even after another turn starts.
Changed input under the same owner/conversation/key conflicts.

A new decision requires the exact run in AwaitingAcceptance, its exact durable
CompletedProposal event, the expected current conversation revision, and the
still-occupied matching binding. Unknown, Failed, Blocked, stale-revision or
superseded authority refuses without writes. One atomic transaction records the
owner event, outbox and receipt, changes only that run to Succeeded and releases
only its binding for a subsequent turn. Provider completion never self-accepts.
No provider sequence, native reference, lease, fence or dispatch locator is
published in this owner event. The completion EventId is explicit typed linkage;
no message causation is manufactured.

`v2/fixtures/execution-accepted.json` illustrates the replay event.
Receipt schema 1 carries both completion and acceptance EventIds, original
requested revision and committed revision, with outcome `succeeded`. Consumers
must validate variant/schema and identity, preserve atomic replay cursors and
recognize the `execution_accepted` SSE name. This checkpoint implements DTOs only;
canonical writes, migration and subsequent-run acceptance remain pending review.
