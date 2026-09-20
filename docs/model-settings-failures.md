# Model setting failures

WebUI and chat model changes share the same owner-scoped settings lock, live
catalog validation, runtime acknowledgement and persistence path.

The runtime must acknowledge a change before Orkestr reports it as applied.
Settings apply to subsequent work; changing a model does not restart a thread
or replace an inference already in progress.

## Rejection versus uncertain delivery

- A correlated JSON-RPC invalid-request, method-not-found or invalid-params
  response rejects the mutation. Orkestr keeps the previous model/effort and
  clears only that operation's pending guard. The API returns 422 and the UI
  permits another selection or retry. An unloaded thread needs to be resumed;
  an unsupported runtime needs updating. Neither condition requires resetting
  the thread or deleting its history.
- A timeout, disconnect, unclassified failure or internal runtime error does
  not prove whether the change happened. Keep the pending guard and require
  operator reconciliation. Reloading the catalog is not confirmation, and
  uncorrelated settings notifications must not clear the guard.
- Owner, operation and Codex generation checks fence both success and rejection
  handling. A response for an old operation cannot unlock a replacement.

The `codex_model_controls` audit event includes bounded `failureKind` and
`rpcCode` fields. It deliberately excludes provider error text, which may
contain private runtime details. Metrics use only operation/outcome labels.

## Operator recovery

Inspect only the affected owner's thread. Preserve the pending expected
settings, operation identifier and Codex generation. Determine whether the
original request is still in flight before retrying; a current settings read
alone cannot prove that a delayed mutation will not arrive later. Do not clear
all uncertainty flags or silently switch to a different/default model.

When explicitly reconciling a settled operation, use the same settings lock,
reassert the user's exact requested settings, and persist them only after the
correlated runtime acknowledgement. Recheck owner, operation and generation
under the canonical storage lock before clearing its guard. If the request's
status remains unknown, keep the guard. Do not interrupt/reset active work.

Validate the public API's model, effort and read-only state after recovery.
An isolated ephemeral protocol test with no inference turn can verify installed
runtime support without consuming a user turn or changing other threads.
