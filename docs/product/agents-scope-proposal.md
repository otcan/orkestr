# Proposal: AGENTS.md scope rules for the Agent Jobs direction

Status: **proposal only. The owner decides.** AGENTS.md is not edited by this
change.

The current AGENTS.md rules define V1 as "setup UI, OpenAI/Codex, Gmail,
LinkedIn virtual browser, WhatsApp, virtual browsers, and timers". That list
names connectors, not the product. Under the
[new positioning](positioning.md), the scope should be defined by the Agent
Job core.

## Proposed replacement for the V1-scope bullets

```md
- Product scope: Orkestr runs AI agents as persistent services. The core is the
  Agent Job (docs/spec/agent-job.md): provider adapters, durable execution,
  event triggers, tool authorization/approvals, then observability/audit, then
  coordination. New work must make a job more durable, more governed, easier
  to trigger, or easier to inspect.
- Freeze peripheral features (docs/product/code-audit.md#peripheral-freeze-list):
  bug fixes only, no new features unless an Agent Job capability needs them.
- Every runtime change must keep the test suite runnable without cloud
  credentials. Use the `simulated` provider and fake backends; adapter
  behaviour is proven in `test/conformance/`.
- Runtime claims in docs/README must cite a guarantee in
  docs/spec/runtime-guarantees.md with a passing test.
- External side effects from agent tools go through the effect ledger with an
  idempotency key; never add a side-effecting tool without a logical key and
  either a reconcile hook or an explicit `at_most_once` marking.
- New job/runtime code goes in new modules (core/agent-job-*.js,
  core/agent-adapters/*); do not grow runtime-leases.js, codex-app-server.js,
  or apps/cli/src/commands.js beyond one-line wiring.
```

## Rules to keep unchanged

The OSS confidentiality rules, the overlay separation, self-hosted defaults,
the boring install path, the release train, file-size limits, and all runtime
orientation and safety rules for agents.

## Rules to relax or drop

* "Do not add enterprise/team/plugin abstractions until the V1 onboarding
  loop is reliable." **Keep it**, but add a carve-out: the provider adapter
  interface and the tool registry are core abstractions, not plugins.
* The LinkedIn and friend-provisioning bullets are deployment workflows.
  Consider moving them to the private overlay docs, leaving a one-line pointer
  in AGENTS.md.

## Open questions for the owner

1. Are WhatsApp and email *notification and approval channels* only, or do
   they remain first-class trigger sources in v0? The spec currently allows
   them as notification channels only.
2. Should `codex` stay the default provider in `orkestr init`, or should the
   default be `simulated` until a provider is connected?
3. Is opt-in usage pinging (needed for the "10 developers" metric)
   acceptable, or should measurement rely only on issues and conversations?
