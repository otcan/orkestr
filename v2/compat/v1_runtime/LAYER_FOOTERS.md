# Observed reply layers

New exports retain their existing IDs, text, ordering and acknowledgement contract. Optional metadata describes the producing layer:

- `layer`: `fast`, `deep`, or `coordinator`.
- `runId` and `identitySource: run`: exact run status, verified against the requested run ID.
- `provider` and `model`: model evidence for that exact run: `models.actual_model`, else the `models.resolved_model` Core resolved for the same run (the V2 UI's fallback too). Missing evidence stays absent (`unreported`); conversation settings never supply an identity.
- `quickProvider`, `quickModel`, `quickObservedReasoningEffort` (Deep finals only): the exact Fast run of the input the final answers, so V1's footer shows the Quick layer without correlating messages (grouped and parallel finals name another input). `quick: "none"` marks a timer final, which no Quick answers.
- `observedReasoningEffort`: only an explicitly reported `models.actual_reasoning_effort` value. Current Core does not report this field, so live effort remains unknown. Selected Fast/Deep preferences are not used as observations.
- `sourceInputId`: original same-ledger input identity, including Fast's notification parent.

External coordinator/operator posts preserve their own provider/model and use `identitySource: post`; the native Deep cannot overwrite them. Native questions retain their exact producing run identity.

A coordinator post with `request_key: coordinator-input:<public-input-uuid>:answer` links only to that exact public input in the same scoped ledger. Legacy, foreign or missing inputs remain unlinked; neither the latest event sequence nor message text supplies a substitute. Replayed posts and pending exports retain their first frozen metadata.

This changes no Core schema/API, provider input, native identity, delivery fence, timer authority or replay policy. It supplies the optional metadata consumed by V1's two-layer footer.
