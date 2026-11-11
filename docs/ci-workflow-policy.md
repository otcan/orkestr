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
or dynamic runners (except the two exact AWS runner selections described
below), local/reusable actions and secret expressions. Build runs
the checker before compilation; ordinary test shards include policy fixtures.
Fixtures are parsed only: no synthetic credential or untrusted action executes.

## Replacing superseded checks

GitHub-hosted runners are shared, and most of a run's time is spent waiting
for one. Runs whose result nobody will use are therefore cancelled or skipped.
`test/ci-run-scheduling.test.js` evaluates the rules below from the workflow
files for every event type.

Each pull request has one concurrency group per workflow (`ci.yml`,
`v2-rust.yml`, `v2-browser.yml`, `v2-image.yml`). A newer run replaces older
pending and running checks for that PR; the current revision still runs the
complete check set. The group uses the PR number, so matching branch names in
different forks cannot cancel each other's checks.

Pushes to `integration` also share one group per workflow. A newer merge
cancels the older integration run: the release train needs complete checks on
the commit it selects, which is normally the newest. Only a newer push to
`integration` can cancel an integration run; PRs, manual runs and every other
event use other groups. A commit whose run was cancelled has no complete
checks. To qualify it anyway, start a `workflow_dispatch` run on it.

Version-tag pushes (`v*`), merge groups, scheduled scans, explicit manual runs
and the `ci/image-cache/**` branches each get a unique run group. Nothing
cancels them; this preserves exact-source validation and publication. A
shared group with `cancel-in-progress: false` would still evict older pending
runs, so these events use `github.run_id` instead. `v2-publish.yml` keeps its
own per-tag group that never cancels.

CI accepts branch pushes only on `integration`, plus `v*` tag pushes. Feature
branches run through `pull_request`, avoiding a duplicate push build for each
PR update. Use `workflow_dispatch` when a branch needs an explicit independent
run. These rules change scheduling only; job names, checkout refs,
permissions, and immutable scanner policy remain intact. See GitHub's
[workflow concurrency documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

The dependency, secret, and test aggregate jobs, and the `rust-v2` summary,
run after failures but stop on workflow cancellation (`always() &&
!cancelled()`). An obsolete aggregate must not hold the concurrency group
while waiting for a runner. Their commands still reject failed, skipped, or
missing upstream results. Step-level evidence uploads and registry logout keep
their cancellation cleanup behavior.

## Draft and docs-only pull requests

Open a pull request as a draft, and mark it ready for review once its local
checks (and the remote builder, if you use one) pass. While a PR is a draft,
only the cheap checks run:
`syntax`, `secret-scan`, `secret-policy`, `dependency-advisories`,
`dependency-policy`, `cargo-advisories` and `cargo-policy`. The jobs that
build or test (`build`, `test`, `smoke`, `image` and the `tests` summary in
`ci.yml`; `lint`, `service`, `http`, `unit` and `rust-v2`; headless
rendering; both V2 image builds) report skipped. The workflow policy check
runs inside `build`, so it also waits until the PR is ready. Marking the PR
ready (`ready_for_review`) starts the full run on the same commit.

In `ci.yml`, a pull request that changes only files under `docs/` and Markdown
files (`*.md`) also skips the jobs that build or test. The small `changes` job
compares the PR's merge base with its head using plain Git and reports
`docs-only=true` only when every changed path matches. If it cannot list the
changes, it reports `false` and the full suite runs. The skipped jobs still
report as skipped, so a docs-only PR can merge. The cheap checks above, and the
`v2-*` workflows when their path filters match, still run.

Pushes to `integration` always run the full `ci.yml` suite, even for a docs-only
merge. The release train's required checks
(`scripts/release-provenance/release-policy.json`) and the provenance
attestation need `build`, `smoke` and every `test` shard to have succeeded on
the exact commit, and a skipped job does not count as success. Some Node tests read documentation
(for example `test/launch-docs.test.js`), so a docs-only PR that breaks one is
reported by that integration run rather than by the PR.

## Ephemeral AWS runners for the heavy V2 jobs (ORK-774)

Most CI time used to be spent queueing for a GitHub-hosted runner. The jobs
that build or test Rust (`lint`, `service`, `http` and the `unit` shards in
`v2-rust.yml`, both image builds in `v2-image.yml`, and headless rendering)
can run on ephemeral self-hosted runners in the owner's AWS account instead.
The policy accepts exactly two runner selections for them
(`awsRunnerSelections` in `scripts/security/workflow-policy.mjs`), only in
those three workflows and only in jobs that hold read permissions. Plain
`self-hosted` labels, other expressions and every other workflow are still
rejected; `v2-publish.yml` and the release gates never use these runners.

A job goes to AWS only if all of these hold, otherwise it runs on the
GitHub-hosted runner named at the end of the selection:

- the repository variable `ORKESTR_AWS_RUNNERS` is `on` (set it to anything
  else to send every job back to GitHub-hosted runners at once);
- the run belongs to `otcan/orkestr`, so forks of the repository never wait
  for runners they do not have;
- the event is a push to `integration` or a tag, a schedule, a manual run, or
  a pull request whose head branch is in this repository. Pull requests from
  forks always use GitHub-hosted runners.

A fork pull request could rewrite `runs-on` in its own copy of a workflow, so
the selection is not the only barrier. The runner side, which lives in the
private operations repository, checks the same rules twice more: the scaler
starts a runner only for a queued job in a trusted run (allowed event, head
repository is this repository), and on the instance a job-start hook fails
any job whose event or head repository is not allowed before a single step
runs. Each instance takes one just-in-time registration, runs one job and
terminates. Instances have no cloud credentials, accept no inbound
connections, cannot reach the production host, and are capped in number,
size, lifetime and monthly spend.

The runner image mirrors the hosted Ubuntu 24.04 paths (user `runner`,
`/home/runner/work`, `/home/runner/.cargo`), so the Rust dependency caches
are shared with GitHub-hosted runs. It ships the per-executable Bubblewrap
user-namespace profile that `v2/tests/ci_lifetime_namespace.py` loads on
hosted runners. On a self-hosted runner that script only verifies the
prerequisite and never changes the host.

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

## V2 unsigned iOS runner exception

Only `.github/workflows/v2-ios.yml` may use the exact GitHub-hosted image
`macos-15`. Other workflows retain the Ubuntu-only runner allowlist (plus the exact AWS
runner selections in the V2 build and test workflows). Floating, larger,
other self-hosted and dynamic runner selections remain rejected. This file
must use only pull-request/push triggers with explicit `v2/` branch filters,
read-only contents permissions and the existing reviewed immutable action pins;
checkout must disable credential persistence. No secrets, signing, provisioning
profiles, certificates, TestFlight or App Store operations are authorized.
The exception permits unsigned simulator build verification; policy tests are
not evidence of simulator execution or native acceptance.
