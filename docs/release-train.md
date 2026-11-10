# Orkestr release train

V2 is the primary application. Product releases follow:

```text
feature branch → integration → prod → main
```

Feature PRs target `integration`. CI tests and builds the integrated candidate.
An explicitly started release train freezes that exact source, advances `prod`
to it, deploys it, and fast-forwards `main` to the **same commit** after
production acceptance. Moving `prod` or `main` does not rebuild the image.
Branch updates alone do not deploy or enable a deployment timer.

`prod` identifies the selected candidate, including a candidate whose rollout
failed. `main` identifies the last accepted source. Never create an additional
merge commit on main after testing: its identity must match the deployed source.
Version tags and registry publication are separate, explicit release actions.

## Ownership and safety

- Workers commit and push their feature branches; their PRs target integration.
- Only the release train selects prod, promotes main, tags or deploys.
- Continue already authorized release phases without asking for permission again.
  Ordinary coding does not itself authorize a production deployment.
- Never discard user work or force shared branch history. Preserve dirty and
  divergent work on its existing branch; resolve clear conflicts and test them.
- Keep deployment identities, credentials, profiles, grants and host bindings in
  the private operator repository. Execute deployment controls from the verified,
  protected operational closure, never from an executor-writable checkout.
- Preserve retained recovery evidence and owner data. A rollout is not a new
  disaster-recovery backup plan; use the approved checkpoint and retention policy.
- Real WhatsApp E2E is optional unless explicitly requested for this release.
  The train's normal synthetic and scoped acceptance checks still apply.

## 1. Inventory and integrate

Fetch remotes, confirm repository boundaries, and inspect worktrees before editing:

```sh
git status --short --branch
git fetch --all --prune --tags
git worktree list --porcelain
git branch -vv --all
```

For corresponding parent, worker and release branches, record the branch,
upstream, dirty files, unique/missing commits and latest subject. Report an
inventory table and classify work as merged, ready, stale, divergent or needing
an intent decision. An unfamiliar directory or dirty worktree is not permission
to delete, reset, stash or commit someone else's active work.

Merge ready feature PRs into integration after the relevant tests and checks
pass. Resolve mechanical conflicts when combined behavior is clear. Preserve
unique legacy-main history during the initial V2 transition; main must be an
ancestor of the eventual candidate so promotion is a normal fast-forward.

Prepare release notes from the actual integrated changes. Newer integration
commits arriving during a train wait for the next train; they do not change the
frozen candidate.

## 2. Test and freeze the candidate

Follow [the contributing guide](../CONTRIBUTING.md) and
[LLM-assisted release procedures](llm-assisted-release-procedures.md). Select
checks for the changed surfaces and record what was tested or skipped and why.

Full V2 workspace and browser suites run in GitHub Actions. Locally run only
affected crate checks through the host's build wrapper when available. Node
bridge changes need their relevant Node tests. Do not run a second full local
Rust build on a shared host.

Require successful applicable Rust, browser, dependency, secret, packaging and
native image checks. Import the successful integration push's exact CI artifact
using the approved provenance and checksum checks. Retain its source identity,
workflow/job/artifact identity, producer hashes and qualification receipts.
Do not substitute a moving branch or another commit's binary.

Complete the package and enabled-configuration qualification against the same
source, server, UI, provider matrix and private plan. Use the existing approved
checkpoint for isolated rehearsal where supported. Rehearsal copies must be
cleaned only after their process ownership and completion are proven.

Stage a reviewable candidate before any activation: exact source, artifact,
configuration, tests, storage forecast, expected behavior and rollback point.
The operator selects that qualified candidate through the protected runtime
configuration. Starting the train consumes this selection; it does not blindly
fetch and deploy the newest integration commit.

## 3. Select prod and deploy

Start the deployment explicitly through the existing release train. Serialize
trains using the deployment locks. Recheck configuration, qualification and
physical storage headroom before draining or stopping anything.

Before the drain, verify that the candidate is contained in integration,
contains main, and does not rewind prod. Fast-forward prod to the exact candidate
with a normal Git push. Observe the remote outcome and retain the intent and
receipt. Stop on an incompatible concurrent ref change or unknown write outcome;
never force or blindly retry a branch update.

The train drains active work, takes the approved stopped rollback checkpoint,
publishes the paired release, starts it under its recovery watchdog, and updates
the adapter and public UI from the same source. A drain refusal leaves the
previous version live. Report that outcome as a refusal, not a completed rollout.

## 4. Accept production and promote main

Promotion requires the existing production acceptance, including:

- Healthy Core with the exact candidate source and current process identity.
- Matching adapter source and healthy enabled bindings and consumers.
- Matching public UI source and bootstrap, qualified backend and verified proxy.
- The scoped chat receipt, released admission control and disarmed restart watchdog.

Only after those checks pass does the train fast-forward main to the exact source
on prod. Verify the remote main SHA and record its observed outcome. A failed or
unverified deployment leaves main unchanged. An additional commit on main would
break source agreement and must not be used as a promotion shortcut.

If GitHub fails after live acceptance, keep healthy production running and record
promotion as pending. Reconcile remote refs and revalidate current acceptance
before an explicit retry. Do not roll back healthy production just because its
GitHub promotion failed, and do not report the train fully complete while the
promotion remains pending.

Before acceptance, rollback restores the previous runtime and leaves main
unchanged. An emergency rollback after acceptance must be recorded separately;
restore the desired state through a new revert/recovery release rather than
rewinding shared branch history. Report the actual live source during that gap.

## 5. Align branches and report

After main advances, fast-forward and push every clean corresponding worker or
release branch whose tip is an ancestor of the accepted source. Preserve branches
with local edits or unique commits. Report their exact dirty/unique/missing state
and whether they belong to the current train or future work. Refresh Orkestr git
state and check WebUI parent/remote drift where that interface is available.
Do not silently leave eligible corresponding branches behind.

Report the accepted version and source, prod/main SHAs, actual rollout duration,
CI and qualification results, public UI identity, rollback target and any pending
promotion or branch alignment. Update the authorized issue tracker and resolve
review findings with evidence before calling the train complete.

## Legacy Node/V1 tooling

V1 and its compatibility bridge remain in the repository. The
[legacy release procedure](release-train-v1.md) documents its Node CLI commands,
provenance gate, fan-out installer and optional diagnostics. Those historical
merge-to-main-before-deploy instructions do not apply to the V2 product train.
