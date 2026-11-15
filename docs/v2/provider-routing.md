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
the prospective read uses the bound window’s eligible inputs; the actual Deep lease is checked again before admission and can be returned
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
never clears consumed/retired inputs or replays a previous run. It waits only
for work ahead of or in flight with that input: a claimed input, a window
intent queued before the input's own, or an input bound to a window that is
not closed. Inputs queued behind it (usually queued only because they
inherited its match while its window was still active) stay queued and are
admitted in order after the switch. The triggering input itself must not carry
an immutable original-source continuation fence; the policy cannot rewrite its
source identity. A queued successor fenced to a run of the previous provider
generation (a host result for the turn that asked for it) can never run after
the switch: the switch withdraws it in its own transaction, retires its input
with the ordinary `source_superseded` receipt and emits a
`window_queue_withdrawn` alert with cause `provider_policy_handoff`. It is
never handed to the new provider. An input without a window intent and outside
every unclosed window is neither ahead nor in flight and stays as it is.
While the switch waits, direct admission answers `409
provider_policy_handoff_blocked` (the input is already queued) and dispatch
backs off, alerting `window_queue_deferred` with cause `provider_policy_refused`
after three refusals.
The original request/digest is queued before potentially slow native retirement,
so cancellation cannot lose its intent. An already accepted idle window uses
ordinary custody-proven retirement; a live working window queues intent until
supported retirement/reconciliation establishes custody release. No running native turn is transplanted.

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
