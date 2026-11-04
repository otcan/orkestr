# Operator provider routing

The selected service plan may include `provider_routing`. This optional,
operator-pinned configuration contains generic weighted terms and conversation
scopes; private classification vocabulary belongs in the deployment overlay.
It is not a model-controlled tool argument or a new approval capability.

```json
{"provider_routing":{"rules":[{
  "id":"synthetic-category","terms":[{"text":"cedar","weight":3}],
  "threshold":3,"excluded":"claude","preferred":"codex"
}]}}
```

A rule matches an explicitly listed `conversations` UUID or reaches its weighted
threshold on the exact prospective input. Terms use case-insensitive word
boundaries and score once per term. Matching exclusions are considered together;
conflicting routes fail closed. No prompt, lexicon or provider reply is logged.

Both immediate admission and durable queue dispatch evaluate the policy before
the window consumes input or starts a broker. Timer-created window requests use
the same boundary. For a fresh conversation, routing records a revision-checked
provider setting, clears overrides from the previous provider and preserves
reply/review/grouping controls. Ordinary Codex model-capacity fallback stays on
Codex. A policy does not grant permission to silently transplant an existing
native session: active windows or committed identities require the established
explicit provider handoff. Failed routing preserves the unconsumed input.

This first slice is **not complete domain isolation**. Classification uses the
current input, not all historical context; put known domain conversations in
`conversations` to protect short continuations. It does not intercept native
Claude subagents/tools inside an already running turn, the separate restricted
runner, or external terminal sessions. Tool/steering input that bypasses window
admission also needs an independent common turn-dispatch guard. Existing native
handoff automation, inherited child-task policy, complete audit provenance and
runtime acceptance remain follow-up work. A local CLI hook is supplementary.
