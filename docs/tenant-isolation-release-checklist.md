# Tenant Isolation Release Checklist

Use this checklist for any release that changes use control, contained user
runtime policy, scoped connector state, browser profiles, WhatsApp routing,
timers, files, or tenant instance boundaries.

Public, demo, customer, and otherwise untrusted users use a tenant VM or tenant
instance as the hard isolation boundary. Shared-process `ownerUserId` checks,
scoped APIs, sanitizer checks, and contained runtime prompts are
defense-in-depth only. Keep `docs/containment-matrix.md` and
`docs/route-security-matrix.md` updated when a release changes any containment
surface or route ownership rule.

## Required Local Checks

Use the tenant and OSS VM isolation procedure in
[LLM-assisted release procedures](llm-assisted-release-procedures.md). The
procedure must inspect the changed isolation surface, compare it with the
containment and route-security matrices, and then run the named tenant isolation
suite before the normal release checks:

```bash
npm run test:tenant-isolation
```

Then run the normal release checks for the changed surface, usually:

```bash
npm run build
node --test --test-concurrency=1
```

If the release touches demo VM bootstrap, public onboarding, broker UUID
routing, or desktop containment, add the isolation audit and preserve its
artifact or output in the release evidence packet:

```bash
npm run audit:isolation
```

## Coverage Expectations

The tenant isolation suite must cover these boundaries:

- Non-admin thread visibility, thread limits, and thread ownership checks.
- Per-user workspace and file roots, including path traversal denial.
- LLM sanitizer fail-closed behavior for non-admin thread and timer actions.
- User-scoped Gmail and Outlook OAuth state, tokens, errors, and message APIs.
- Browser desktop profile and lease isolation by user.
- Contained user Codex runtime policy injection and host-skill denial.
- WhatsApp auto-provisioning, routing, debug footer suppression, and sanitizer
  failure notification for contained users.
- Dynamic `whereiam` policy metadata for contained user sessions.
- Tenant VM boundary metadata and the containment matrix for public isolation.
- Route ownership across REST and WebSocket surfaces, including summary streams,
  raw terminal access, and control-plane admin-only routes.

## Manual Release Verification

After deployment, verify:

- `orkestr version --json` reports the intended commit and release id.
- `orkestr status` reports `ok`.
- A non-production test thread can receive one message and return one final
  answer.
- No new runtime interruption notice is created after the deployed timestamp.
- Any active worker skipped by post-deploy sync is reported as skipped, not
  force-updated.

## Public Safety

Keep this checklist generic. Do not add private hostnames, real WhatsApp chat
ids, connector tokens, Gmail or Outlook account identifiers, browser profile
paths from a live operator, or private overlay details.
