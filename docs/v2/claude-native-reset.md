# Claude native continuity reset

A native `system/init` proves that Claude observed the requested session. It
does not prove that the CLI has written a resumable transcript. If the process
ends before that write, the next `--resume` can fail with `No conversation
found`. Reconciliation still records the interrupted turn as failed; it never
replays it or invents a native transcript.

The owner can explicitly replace native continuity through:

```text
POST /api/v2/conversations/{id}/window/reset-native
```

```json
{
  "request_key": "owner-claude-reset-1",
  "window_id": "11111111-1111-4111-8111-111111111111",
  "generation": 2,
  "acknowledge_native_history_loss": true
}
```

Use the ordinary owner browser authentication, Origin and CSRF guard. First
reconcile the exact window with the existing `/window/reconcile` endpoint.
Reset requires the latest window to be closed, every run terminal, the manager
window retired with all owned children reaped, no live local task and no queued
window intent. The conversation must already select Claude; reset cannot
change provider, account, model or effort. Missing acknowledgement, stale
window/generation, unknown fields and unsafe state refuse the operation.

Migration 0069 records an immutable `conversation_native_resets` receipt and
retires the old Fast/Deep bindings. It preserves their IDs and all conversation
messages, imported history, observations, payloads, timer state and delivery
receipts. It does not copy an old native transcript into a new one. Imported
history remains in the conversation; native-only memory is lost as explicitly
acknowledged. The same request key and body return the existing receipt while
the same closed window is current; changed semantics conflict.

Reset admits no input and starts no process. A separately admitted new input
opens the next monotonically numbered window with fresh Fast/Deep native
identities. That fresh lineage then resumes normally in followups and
successor windows. Old uncertain inputs are not retried by reset.

A failed successor can have completed Claude setup without ever consuming an
input. Reconciliation archives its unobserved native reservations in
`execution_window_failed_native_requests`, alongside existing failed-resume
metadata, before restoring the prior retired lineage. A reservation with an
observed run, a busy binding or any own run cannot use that setup-only path.
The failed-first-opening bootstrap path supports both installed providers.

For host full access, the native `system/commands_changed` command catalog may
exceed the generic 16 KiB notice bound. The broker discards the closed catalog
shape under its existing 4 MiB native-frame bound and notice-count limit. It
never forwards command descriptions or treats the catalog as readiness,
inference, a tool grant or completion. Other notices retain their smaller bound.

The synthetic root-manager HTTP qualification covers the larger first-launch
catalog, active-window refusal, acknowledged reset without history/run changes,
fresh identities, followup and successor resume. Core tests also cover failed
Claude resume setup, foreign/stale intent, idempotency, and provider isolation.
