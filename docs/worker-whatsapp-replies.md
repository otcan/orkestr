# Explicit WhatsApp reporting for delegated workers

A worker's WhatsApp binding does not authorize exporting every internal task.
For an owner-authorized task that should report to that worker's group, use:

```sh
orkestr send worker-example "Implement the assigned task" --reply-whatsapp --idempotency-key task-example-v1
```

Authenticated API callers use `POST /api/threads/:threadId/input` with
`workerReplyDelivery: "bound_whatsapp"` and a stable `clientMessageId` or
`idempotencyKey`. Do not supply chat/account IDs or a reply intent. The server
requires an actual worker and parent owned by the requesting user, and an
eligible WhatsApp binding. It snapshots the thread, owner, account, chat and
binding revision in the existing durable reply-intent format. An invalid binding
is rejected before enqueue, not accepted with silently missing replies.

Claude uses this intent for bounded, redacted progress and its final answer.
Both pass through the normal durable WhatsApp outbox and deduplication path.
Progress does not consume the final-delivery intent. A changed owner, binding,
account or disabled mirroring fails closed; old output is never retargeted to a
new group. Plain CLI assignments remain private. Hush remains final-only.
Worker binding generations are maintained under the thread-record lock, so
disable/re-enable and rebind-back cannot resurrect an old intent. Delivery also
re-reads the stored intent and binding just before transport submission.

## SRE diagnosis and recovery

Compare the scoped thread message history, runtime status, binding resolution,
connector outbox and bound group's managed chat history. A healthy binding or
running model alone does not prove delivery. Look for the input's server-authored
intent, assistant parent correlation, progress/final routing and a transport ACK.
Only transport ACK confirms submission; it is not proof the owner read the reply.

The original gap was CLI assignments carrying no WhatsApp origin: Claude emitted
no progress and its final copied empty routing fields, so the mirror skipped it
before creating an outbox job. This affects delegated CLI work, not just one
model subscription. A separate attachment staging failure can coexist and must
not be mistaken for this routing gap. Also, Claude currently queues new inputs
behind its active turn; this change does not introduce live steering.

Do not bulk replay history or retrofit intents onto old inputs. For existing
missed output, review the exact owner, message, current/original binding and
outbox evidence, then use an explicitly authorized managed delivery operation
for a concise current status. Do not resend the implementation task, interrupt
active work, reset pairing, bypass connector approval or auto-approve runtime
tool permissions. Future assignments must use the reporting option above.

Release acceptance: after the coordinated release, submit one scoped test task
with a stable idempotency key, confirm progress and final ACKs in the intended
group, retry the same input and verify no duplicate execution or sends. Local
fake-transport tests alone are not production delivery proof.
