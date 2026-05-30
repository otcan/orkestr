# Tenant Isolation Release Checklist

Use this checklist for any release that changes use control, contained user
runtime policy, scoped connector state, browser profiles, WhatsApp routing,
timers, files, or tenant instance boundaries.

## Required Local Checks

Run the named tenant isolation suite before the normal release checks:

```bash
npm run test:tenant-isolation
```

Then run the normal release checks for the changed surface, usually:

```bash
npm run build
node --test --test-concurrency=1
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
