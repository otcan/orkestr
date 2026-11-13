# Internal tool results and normal task replies

An operator can set the optional adapter service field `internal_context_dir`
to a Root-owned directory with mode `0700`. A trusted producer publishes an
immutable `0400`, single-link JSON record named `<text-sha256>.json` before it
submits the corresponding machine input to Core:

```json
{
  "format": "orkestr-internal-context-v1",
  "conversation_id": "a1000000-0000-4000-8000-000000000008",
  "text_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "operation_id": "a1000000-0000-4000-8000-000000000009",
  "artifact_sha256": "1111111111111111111111111111111111111111111111111111111111111111"
}
```

Use actual digests of the admitted UTF-8 text and the Native-readable result
artifact. Publish and fsync both before the Core POST. The input can reference
the artifact instead of embedding tool JSON. This record controls presentation
only; it grants no execution authority and changes no request retry policy.

The adapter checks the record's custody, exact text digest and conversation.
It then awaits the input's ordinary exact-source Deep run without exporting the
machine input. Useful Deep progress keeps the existing settle interval, payload
deduplication and binding policy. Its accepted final answer uses the existing
delivery and acknowledgement path. Both use a synthetic parent with no timer
namespace, so the transport can present them as ordinary task replies rather
than scheduled reminders: the answer carries `timerSourceId: "task-update"`
and a progress note `timerSourceId: "task-update-progress"`, which the
WhatsApp footer marks as an update.

Unregistered owner text, JSON and API messages retain their existing behavior.
A malformed or untrusted matching record stops that scan before an echo or
cursor advance. Missing accepted output never becomes a manufactured success.
The existing durable ledger, export IDs and acknowledgements survive adapter
restarts; operators must not replay completed commands to test delivery.
