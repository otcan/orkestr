# CI workflow policy (ORK-507 / ORK-508)

All external actions use reviewed immutable commits with adjacent version
comments. Checkout explicitly disables credential persistence. The workflow
and jobs inherit only `contents: read`: no write or OIDC permission is needed.
The inventory in `scripts/security/workflow-policy.mjs` is deliberately narrow:
official checkout v6.1.0, setup-node v6.5.0, upload-artifact v4.6.2 and
download-artifact v4.3.0. Tag refs were resolved through the official GitHub
`actions/*` repository API, not a third-party mirror.

`npm run security:workflows` parses every workflow with pinned YAML 2.9.1 and
rejects duplicate keys, aliases/anchors/tags, mutable or unreviewed actions,
credential persistence, elevated permissions, privileged triggers, self-hosted
or dynamic runners, local/reusable actions and secret expressions. Build runs
the checker before compilation; ordinary test shards include policy fixtures.
Fixtures are parsed only: no synthetic credential or untrusted action executes.

## Updating or reverting

1. Review the official upstream action release and resolve its tag to the full
   commit via `gh api repos/actions/<action>/git/ref/tags/<version>` (dereference
   an annotated tag object if present). Review the commit/diff and permissions.
2. Update the inventory and every corresponding workflow SHA and version comment
   together. Do not substitute a moving tag, local action or permission exception.
3. Run `npm run security:workflows` and the workflow/secret/dependency security
   tests. Run the exact candidate's CI before requesting integration.
4. Revert through a reviewed commit restoring the previous known-good pin and
   inventory together. Do not bypass failures by granting write credentials.

## What this does not enforce

These are repository checks, not a sandbox or administrative branch protection.
Candidate code can modify candidate checks; therefore protected reviews of
workflows, scanner/config/policy and lockfiles remain essential. No privileged
`pull_request_target` or `workflow_run` execution is introduced. Dependency
advisory/lifecycle checks retain their existing immutable base-policy checkout.
The new scanner remains in the candidate's read-only job and its policy changes
require protected review; do not interpret it as a trusted unmodifiable gate.

ORK-478 owns live ruleset/required-review activation. No ruleset, protected
branch setting, credential, runner configuration or production service is changed
by this patch. `secret-policy` should be reviewed as a required check alongside
the existing dependency gate; adding a job alone does not enforce merges.

ORK-508 qualification still needs exact-candidate CI evidence and a separately
approved inventory of remote refs before claiming complete private-repository
history coverage. A clean synthetic or range scan does not qualify all refs or
justify closing security alerts. Retain only aggregate schema-v2 evidence; never
attach raw/redacted finding payloads to Jira or CI artifacts.
