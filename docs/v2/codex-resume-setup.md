# Codex resume setup

`PreparingCodex::open_retained` keeps its existing opaque Core metadata grant
interface. A grant binding with a native session identity selects `thread/resume`;
a binding without one selects `thread/start`. No HTTP native identity argument is
accepted. A failed resume quarantines setup and never falls back to creation.

Resume emits exactly `threadId`, canonical `cwd`, `approvalPolicy: never`,
`sandbox: read-only`, and `modelProvider: openai`. The response must preserve the
exact selected identity, both workspace and provider proofs, explicit persistent
state, and read-only/network-disabled policy. Account readiness remains a
separate subscription check. Setup grants never authorize inference; confirmation
and fresh consumed dispatch attachment remain mandatory.

This parser/setup checkpoint is not runnable restart qualification. It still
requires the matching closed broker resume launcher/metadata whitelist and Core's
eligible terminal or owner-accepted one-use metadata grant. The server factory
must prove the previous owned child has actually been reaped before replacement;
revocation or an interrupt acknowledgement is insufficient. Unknown work remains
reconciliation. Existing same-process reusable-session modules are unchanged.

Focused tests exercise exact resume framing and refusal of missing or changed
identity/workspace/provider/persistence/sandbox evidence, with no creation fallback.
They do not exercise a resumed provider process or claim real-provider acceptance.
