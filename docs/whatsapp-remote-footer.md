# WhatsApp footer

Every chat whose footer is enabled gets the same footer: owner-only chats,
shared groups with members, and replies to a member's input (owner decision
2026-10-28). Only tenant isolation, the per-thread/chat footer-off switch
(`suppressWhatsAppDebugFooter`, `whatsappDebugFooter: false`, the
`ORKESTR_WHATSAPP_SUPPRESS_DEBUG_FOOTER_*` lists) and the global footer flag
remove it.

Model replies (Quick, Deep final, grouped/parallel Deep final, coordinator
post, timer answer, health-probe answer, V1-native reply):

```text
⚡ Quick: <provider model | —> · 🧠 Deep|Coordinator: <provider model | pending | —> · ▶ <Quick|Deep|Coordinator|Post>[ · update]
codex <5h/wk quota | no data>
claude <5h/wk quota | no data>
q:<n> · load:<n>% · api:<n>% · help:/help
```

`—` means the layer did not run for this input (a timer, a probe, Fast off) or
its identity was not observed; `pending` means a Quick reply went out before
its Deep final; `codex ?` means the provider is known but no model was
reported; `· update` marks a progress update. V1-native threads show Quick `—`
and append `mode:plan` / `fast:on` only when on.

Notices (⚙️ System, 🚨 alerts, Operator posts, queue/mode/router/delivery
notices, and the scoped transport's operator-notice send class used by
orkestr-notify's fallback) carry only the two quota lines and the q/load line.

These fields belong to exported message/run evidence, never local thread or account defaults:

- `provider`, `model`: the answering run's observed identity; a coordinator post's own preserved identity.
- `layer`: `fast`, `deep`, `coordinator`, or `notice`. The existing explicit `firstResponse: true` also identifies Fast. An adapter export with `kind: notice` uses writer `Notice`, independently of its delivery phase; it cannot fill a counterpart Deep identity. Other non-first, non-post `final_answer` exports default to Deep. Post parents without an author never become Deep; they are writer `Post`. A native question post keeps its exact-run Deep identity.
- `identitySource`: `run` or `post`. Coordinator identities require `post`; older adapters can overwrite these with an unrelated native identity, so they display unknown.
- `observedReasoningEffort`: optional observed `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. Configured effort alone does not qualify.
- `sourceInputId`: original input identity shared by the layers, including synthetic notification parents.
- `runId`: optional answering run identity.
- `quickProvider`, `quickModel`, `quickObservedReasoningEffort` (Deep finals): the exact Fast run of the input the final answers; `quick: "none"` on a timer final. V1 stores them as `remoteQuick*` and prefers them over correlating the Quick reply.

V1 preserves these as `remote*` message metadata. A counterpart is shown only for the same explicit original input, backend and remote thread, with agreeing observed identities. Different inputs, missing evidence and conflicting observations show `—`. The current message never borrows its writer's identity from another layer.

Existing exports without the extended fields continue to deliver, with unknown facts shown as `—`. In particular, the adapter must preserve coordinator post identity before it can be displayed as observed.

Coordinator author evidence flows from the adapter ledger listing (`postAuthor` on the pseudo-parent) through `materializeRemoteTimerParent` into the stored parent `postAuthor`. The importer receives that exact parent. Existing timer-parent tests cover this materialization. A missing post author leaves the role unknown. A Quick message with no correlated later layer yet shows `pending`.
