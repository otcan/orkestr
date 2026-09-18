# Draft attachment main-merge evidence

Date: 2026-09-17. Scope: local, untagged merge to `main`; no remote publication
or deployment. Baseline: `c07d8138` (0.1.0-alpha.196). The parent branch is
`orkestr/ork-486-remote-compaction-recovery`; its changes are the draft attachment
implementation, not additional remote-compaction changes.

## Changed surfaces

- Browser-encrypted eager uploads, named pasted text, per-thread draft recovery,
  cancellation and a logout recovery fence.
- Server-authoritative attachment claims and message idempotency, serialized
  against cleanup/removal with a durable claim journal.
- Owner-authorized encrypted previews, bounded archive parsing in a Web Worker,
  desktop sidebar and mobile full-screen presentation.
- Additive lifecycle metadata, feature controls, telemetry and static assets.

Tenant VM/instance isolation remains the hard boundary. Owner and path checks
are defense-in-depth; this change does not introduce a shared-host containment
guarantee. See `draft-attachments.md` and `route-security-matrix.md`.

## Checks and artifacts

Checks used a scrubbed test environment, not production connector configuration.

| Check | Result | Local artifact |
| --- | --- | --- |
| `npm run build` | Passed | `/tmp/draft-attachments-verified-build.log` |
| `npm run web:build` after final browser changes | Passed | `/tmp/draft-attachments-final-web.log` |
| Six focused Node test files: draft attachments, browser upload queue, archive worker, inbound upload, thread wizard, architecture | 59 passed | `/tmp/draft-attachments-verified-focused.log` |
| `npm run test:ci` | 2,356 passed, 6 skipped, no failures | `/tmp/draft-attachments-stable-ci.log` |
| `npm run test:tenant-isolation` | 655 passed | `/tmp/draft-attachments-merge-tenant.log` |
| `npm run smoke` | Passed, including persistence across restart | `/tmp/draft-attachments-merge-smoke.log` |
| `npm run web:verify-static`, `npm run oss:boundary-check`, `git diff --check` | Passed | Operator command output |

The final logout recovery guard has its own passing focused regression; it was
added after the full-suite run began. An earlier CI run overlapped server output
generation and failed one module import. That test passed alone and the stable
rerun above passed. No product workaround was introduced for the build overlap.

No live WhatsApp/OAuth traffic, VM provisioning or deployment was requested, so
live transport and VM audit gates were not run. Physical iOS/Android browser
qualification remains a release gate. Remote CI is not triggered by a local merge.

## Integration and rollback constraints

The fetched local and remote `main` baseline matched the implementation base.
Corresponding checked-out worker/release branches were clean and had no unique
commits. Preserve the implementation in a normal commit, merge to local `main`,
and fast-forward clean corresponding branches without rewriting history. Remote
branches intentionally remain unchanged until publication is authorized.

No version bump, release tag, deployment, host configuration, or key activation
belongs to this merge. Feature-disable is the supported initial rollout rollback;
do not deploy an older cleanup implementation against claimed attachment records
without a compatibility review.
