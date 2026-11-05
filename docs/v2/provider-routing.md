# Operator provider routing

The selected, sealed service plan may include `provider_routing`. Generic
weighted terms and conversation scopes come from the operator overlay; private
classification vocabulary is never built into Orkestr or logged. HTTP bodies,
model tool arguments and external CLI hooks cannot install this policy.

```json
{"provider_routing":{"allow_native_handoff":false,"rules":[{
  "id":"synthetic-category","terms":[{"text":"cedar","weight":3}],
  "threshold":3,"excluded":"claude","preferred":"codex"
}]}}
```

A rule matches an explicit `conversations` UUID, its weighted threshold on the
exact canonical prospective input, or a prior immutable match in that same
owner/conversation. Thus a short continuation and managed descendants inherit
the conversation's policy. Only currently configured rule IDs participate;
removing a rule is an operator policy change. Terms use case-insensitive word
boundaries and score once per term. Conflicting exclusions fail closed.

Immediate, durable queued and timer window requests share this boundary. A
fresh conversation records a revision-checked provider setting, clears the old
provider's model/effort and preserves reply/review/grouping controls. Deep and
Fast also check canonical input before native setup and before the next claim;
the actual Deep lease is checked again before admission and can be returned
without creating a run or consuming a dispatch. Worker setup inherits the same
conversation policy. Managed Workers currently launch Codex only. Steering
which would use an excluded provider remains ordered ordinary queued input,
without a native transport reservation. Its actual steering receipt can create
a durable successor-window intent; restart recovery considers only never
consumed queued steering, and cannot revive an explicitly withdrawn intent.

`allow_native_handoff` defaults to false. Enabling it is standing operator
permission for a **fresh native session**, not permission to transplant one.
A handoff requires a source-stamped server build, the exact latest CLOSED Core
window, manager proof that that same window retired, no live local custody,
settled prior contexts and descendants, and revision/generation fences repeated
inside the transaction. It preserves the exact triggering queued input and
never clears consumed/retired inputs or replays a previous run. Other older
queued/claimed work blocks automatic handoff for explicit reconciliation.
An input carrying an immutable original-source continuation fence also blocks
this automatic handoff; the policy cannot silently rewrite its source identity.
A live prior window queues intent until supported retirement/reconciliation
establishes custody release. No running native turn is transplanted.

Core records immutable matched-rule scope, policy digest and server source.
Operator handoff provenance is separate from an ad-hoc explicit owner handoff.
The existing fresh-binding/history delivery path carries bounded canonical Core
excerpts as quoted historical context, granting no execution/tool authority;
only the separately admitted new input is current. Provider and settings epochs
advance together. Existing explicit owner handoff still rejects queued inputs.
A lost/uncertain handoff never authorizes replay of a business input.

This policy covers Orkestr-managed admission and scheduling. It does not
control an external standalone terminal session or native subagents/tools
already executing inside an earlier turn. Lexical classification is bounded
and depends on the operator vocabulary and scoped conversations; it is not a
claim of universal semantic classification. Local CLI hooks are supplementary.

`v2/tests/identity_split_provider_policy_http.py` is an opt-in root-only
acceptance harness using actual Root/Core/HTTP paths and fixed synthetic Claude
and Codex executables. It has no provider API, live account or deployment side
effects. Its receipt must name the exact server source and binary; merely
adding the harness does not qualify a release.
