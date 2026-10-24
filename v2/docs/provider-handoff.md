# Change a conversation's provider with carried context

An owner can change a conversation's provider after its latest work window is
closed and the manager has released its processes and budget. Use **Chat
settings → Change provider with context**, review the summary and explicitly
confirm the new session. Existing inputs, outputs and native-session identities
remain in history. The action starts no work: send a new message afterward.

The server refuses active or uncertain custody, unfinished runs or descendants,
queued inputs (including held ones), queued window intents, stale settings or
window generations, and unknown or foreign scope. Once native history exists,
the ordinary settings endpoint cannot change the provider. Default model policy
rejects `fable`, including case variants and provider-qualified aliases, at
settings, handoff and native-launch validation. Reading legacy settings remains
possible so the owner can move away from a denied model.

## Owner API

`POST /api/v2/conversations/{id}/provider-handoffs` requires a current owner
browser session, the configured origin and a CSRF token. A machine credential
does not authorize this action. The request is:

```json
{
  "request_key": "synthetic:provider-handoff",
  "window_id": "00000000-0000-4000-8000-000000000001",
  "generation": 5,
  "expected_settings_revision": 3,
  "target_provider": "codex",
  "model": "gpt-6.1-sol",
  "reasoning_effort": "high",
  "acknowledge_new_native_session": true,
  "history_summary": "Reviewed prior decisions and context. No old actions are to be replayed."
}
```

The summary must contain 1–16384 UTF-8 bytes, non-whitespace content and no NUL.
It is private historical context; it grants no tools, execution or replay
authority. The request accepts no caller-selected native IDs or unknown fields.
NO_REPLY behavior, reply prefix/footer, review policy and unrelated settings are
preserved. Settings revision and provider generation advance once.

The receipt identifies the decision, conversation, closed window, old/new
provider, new settings revision, provider generation, summary hash and time. It
does not expose summary text. Exact-key retries return the same receipt; changed
semantics under the same key refuse. After an interrupted response, retain that
request and key. Read its receipt with the owner-authenticated
`GET /api/v2/conversations/{id}/provider-handoffs/{request_key}`, or retry the
exact same POST. A successful lookup creates no new authority, even after a
later work window opens. An uncertain outcome is never a reason to create a
replacement key.

## Fresh sessions and dispatch

The handoff transaction retires the old Fast/Deep bindings and appends an
immutable audit. It creates no input, window, native process or delivery. The
next separately admitted input uses ordinary setup to create fresh role bindings
and native IDs; neither old provider session is resumed.

Each fresh Fast/Deep binding receives the reviewed summary once, as labelled
historical context in its first persisted dispatch envelope. The envelope and
once-per-binding marker commit in the same transaction that consumes dispatch.
An uncertain delivery follows ordinary reconciliation and cannot mint a second
dispatch capability. Later turns do not append the summary again. Worker
authority still comes only from its normal explicit delegation.

Schema 73 retains the complete private summary, original native identities and
decision receipt. Once later work has been accepted or delivered, do not roll
back that durable state over the new history. Provider reversal requires a new
supported decision after another closed window, rather than an ordinary settings
flip or direct database edit.

## Deadline continuations

The adapter refuses an automatic continuation when the cancelled run's exact
provider differs from the conversation's current provider, or when its lineage
cannot be proved. It freezes the current provider generation with the continuation.
Legacy requeued inputs without this proof require review rather than replay.

The next `POST /messages` includes `expected_provider_generation` and the exact
`continuation_source_run_id`. Core also checks the source run's scoped Deep
binding is not retired and still matches the selected provider. A handoff away
and back cannot revive that retired binding, even with a current generation.
Core checks it under the same write transaction as fresh input admission.
If the provider changed, HTTP409 `provider_generation_changed` commits no
message, event, inbox, outbox or sequence change. Exact-key receipt retries do
not create another input. Once guarded admission commits, the ordinary queued
input fence prevents a concurrent handoff from crossing that continuation.
