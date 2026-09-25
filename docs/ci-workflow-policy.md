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
The secret scanner, configuration and exact-finding reviews also execute from
the immutable PR/merge-queue base checkout (`.secret-policy`), never from the
candidate tree being scanned. For main, scheduled and explicitly dispatched
workflows, policy is pinned to the event SHA. Candidate scanner/config changes
cannot change that run's detector rules or write fabricated passing evidence.
There is no fallback when the trusted base lacks the new scanner interface: the
bootstrap fails closed and requires owner-reviewed local qualification and
initial landing before subsequent PR validation. Do not disable checks to make
the bootstrap pass.

The workflow definition itself still requires protected review or an externally
managed required workflow. A contributor able to rewrite the CI job and its
checks can bypass candidate-side validation; a trusted base checkout alone is
not administrative enforcement. No live enforcement claim is made here.

ORK-478 owns live ruleset/required-review activation. No ruleset, protected
branch setting, credential, runner configuration or production service is changed
by this patch. `secret-policy` should be reviewed as a required check alongside
the existing dependency gate; adding a job alone does not enforce merges.

ORK-508 qualification still needs exact-candidate CI evidence and a separately
approved inventory of remote refs before claiming complete private-repository
history coverage. A clean synthetic or range scan does not qualify all refs or
justify closing security alerts. Retain only aggregate schema-v2 evidence; never
attach raw/redacted finding payloads to Jira or CI artifacts.
