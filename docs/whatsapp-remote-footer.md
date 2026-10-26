# Remote WhatsApp footer identities

Remote replies show `⚡ Quick: provider model/effort · 🧠 Deep: provider model/effort · ▶ writer`.
Coordinator posts use `Coordinator` in place of `Deep`. Quota and queue/load lines keep their existing format.

These fields belong to exported message/run evidence, never local thread or account defaults:

- `provider`, `model`: the answering run's observed identity; a coordinator post's own preserved identity.
- `layer`: `fast`, `deep`, `coordinator`, or `notice`. The existing explicit `firstResponse: true` also identifies Fast. An adapter export with `kind: notice` uses writer `Notice`, independently of its delivery phase; it cannot fill a counterpart Deep identity. Other non-first, non-post `final_answer` exports default to Deep. Post parents without an author never become Deep.
- `identitySource`: `run` or `post`. Coordinator identities require `post`; older adapters can overwrite these with an unrelated native identity, so they display unknown.
- `observedReasoningEffort`: optional observed `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. Configured effort alone does not qualify.
- `sourceInputId`: original input identity shared by the layers, including synthetic notification parents.
- `runId`: optional answering run identity.

V1 preserves these as `remote*` message metadata. A counterpart is shown only for the same explicit original input, backend and remote thread, with agreeing observed identities. Different inputs, missing evidence and conflicting observations stay `unknown`. The current message never borrows its writer's identity from another layer.

Existing exports without the extended fields continue to deliver, with unknown facts shown explicitly. In particular, the adapter must preserve coordinator post identity before it can be displayed as observed.

Coordinator author evidence flows from the adapter ledger listing (`postAuthor` on the pseudo-parent) through `materializeRemoteTimerParent` into the stored parent `postAuthor`. The importer receives that exact parent. Existing timer-parent tests cover this materialization. A missing post author leaves the role unknown. A Quick message with no correlated later layer yet shows `pending`.
