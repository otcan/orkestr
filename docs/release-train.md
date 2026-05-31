# Orkestr Release Train

This is the Codex procedure for regular Orkestr OSS releases when work is spread
across a parent thread and multiple worker branches.

Use this runbook when the user says "release train", "prepare release", "cut a
release", or "collect workers and release".

## Ownership

- Worker threads may commit and push their own worker branches.
- Parent threads may integrate worker output into the parent feature branch.
- Only the release train may merge to `main`, create release tags, push release
  tags, or deploy to any host.
- Do not deploy from a worker or parent thread as a side effect of normal coding.
  Deployments go through this release train so tests, CI, tags, and release
  metadata stay coherent.

## Safety Rules

- Never discard user work.
- Never force-push unless the user explicitly asks for a specific force-push and
  the target branch is not shared release history.
- Fetch remotes before classifying branches.
- Dirty worktrees are not automatically blockers. Preserve clear dirty changes
  on their own branch with a normal commit before integration.
- Conflicts are not automatically blockers. Resolve mechanical conflicts when
  the intended result is clear and tests can validate it.
- Escalate only when a dirty change or conflict is semantically unclear,
  contradicts another worker, touches secrets/private data, or leaves tests
  broken.
- Stop before merge-to-main, tagging, pushing, or deploying unless the user has
  explicitly asked for that release phase.

## Inputs

Before changing branches, identify:

- Target branch: usually `main`.
- Parent feature branch: the root branch for this release train.
- Worker branches: branches belonging to the same Orkestr parent thread.
- Release kind: untagged main release, prerelease tag, patch tag, minor tag, or
  user-specified tag.
- Required checks: at minimum build, unit tests touched by the train, smoke
  checks, and CI.
- Deployment target: none by default. A deployment target must be named by the
  user or host config; do not invent private hostnames.

## Phase 1: Inventory

Run:

```bash
git status --short --branch
git fetch --all --prune --tags
git branch -vv --all
git tag --sort=-creatordate | head -20
```

For each parent and worker worktree, capture:

- current branch
- upstream branch
- dirty files
- untracked files relevant to the task
- ahead/behind versus upstream
- ahead/behind versus parent
- ahead/behind versus target
- latest commit subject

Report a table before integrating.

## Phase 2: Classify

Classify each worker:

- `already merged`: worker tip is contained in parent or target.
- `ready`: worker has unique commits, clean or checkpointed, and merges cleanly.
- `dirty-checkpointed`: dirty changes were preserved in a normal commit on the
  worker branch.
- `stale`: worker has no unique commits and is behind parent or target.
- `diverged`: worker has unique commits and is behind parent or target.
- `needs-human`: intent is unclear, conflict is semantic, private data appears,
  or tests remain broken after a clear fix.

Classification is a release planning tool, not a warning dump. Include the
missing commit counts and the exact branch relationship so the user can see why a
worker is safe, stale, or divergent.

## Phase 3: Preserve Local Work

For each dirty worktree:

1. Inspect `git diff --stat`, `git diff`, and `git status --short`.
2. If the changes are coherent release work, create a normal checkpoint commit
   on that same branch.
3. If unrelated generated files can be ignored, leave them uncommitted only when
   they are already ignored or clearly build output.
4. If the changes are unclear, contain secrets, or mix unrelated work, stop and
   ask the user.

Use clear commit subjects, for example:

```text
Checkpoint Worker 3 release changes
```

Do not stash and forget changes. A release train should leave an inspectable git
history.

## Phase 4: Integrate Workers

Work from the parent feature branch after it is updated from its upstream.

For each `ready`, `dirty-checkpointed`, or clear `diverged` worker:

1. Merge the worker into the parent with `--no-ff`.
2. Resolve mechanical conflicts when the intended combined result is clear.
3. Run the smallest relevant test for that merge if the conflict touched code.
4. Commit the resolved merge.
5. Stop and ask only if the conflict changes behavior in a way Codex cannot
   defend.

Do not merge workers that are classified `needs-human`.

## Phase 5: Test Locally

The release train owns tests. Run the checks appropriate to the changed surface:

- server/build changes: `npm run build:server`
- web/UI changes: `npm run web:build`
- runtime/install/deploy changes: targeted Node tests plus shell syntax checks
- tenant isolation, use-control, scoped connector, browser profile, or contained
  user runtime changes: `npm run test:tenant-isolation` and the
  [tenant isolation release checklist](tenant-isolation-release-checklist.md)
- broad release train: `npm run build` and `node --test` or the repo's CI runner
- smoke-sensitive deploy changes: `npm run smoke`
- attended deploy/regression changes: `npm run release:regression -- --target
  local=http://127.0.0.1:$ORKESTR_PORT`, adding `--execute --thread <test-id>`
  only when a real test chat is intentionally allowed

If tests fail, fix clear failures inside the release train. Escalate only when
the failure implies a product decision or contradicts a worker's intent.

## Phase 6: Merge To Main

Only after local checks pass:

1. Fast-forward or merge the latest `origin/main` into the parent if needed.
2. Merge the parent into `main`.
3. Re-run the release-level checks that can catch integration mistakes.
4. Prepare release notes from the worker merge commits and notable direct parent
   commits.

Do not push `main` until the user has confirmed the final release plan or has
explicitly requested merge and push.

## Phase 7: Version And Tag

For untagged dogfood/main deployments, do not bump `package.json`. The release id
will be `main-<short-commit>` from the versioned deployer.

For public release checkpoints:

1. Bump the version intentionally, for example `npm version prerelease --preid alpha`.
2. Verify the tag matches the package version.
3. Keep the tag local until tests pass and the user confirms publishing.

Create tags for intentional public checkpoints, installer/runtime changes,
hotfixes, and documented milestones. Do not create tags for every host install.

## Phase 8: Push And Watch CI

After explicit confirmation:

```bash
git push origin main
git push origin <tag>
```

Then watch CI. Prefer the repository's standard CI visibility:

- If GitHub CLI is available and authenticated, use `gh run list` and
  `gh run watch`.
- Otherwise, inspect the remote CI status through the configured provider or ask
  the user for the CI link.

The release train is not complete while CI is pending. If CI fails, fix clear
failures and repeat the release checks. Escalate only when failure ownership is
unclear.

## Phase 9: Deploy

Deploy only after local release checks and CI pass, unless the user explicitly
requests a pre-CI deploy.

Use the versioned deployer:

```bash
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel>
```

Versioned deploys are no-interrupt by default. On current host-native installs,
Codex app-server runs as its own service and Orkestr talks to it through a short
proxy connection, so UI/API restarts do not stop active Codex turns. The deployer
still writes a drain marker before restart so new UI, WA, and timer inputs queue
instead of starting new turns during the deploy window. The drain marker stays
active until the new UI/API process passes health checks; startup recovery
defers while that marker is active so continuing Codex app-server turns are not
misclassified as restart interruptions. The deployer also writes a versioned
systemd drop-in that makes the API `node` process the service main process; this
avoids `npm start` wrapper orphans. The systemd unit uses `KillMode=mixed` so
the release restart gives the UI/API process a normal shutdown window while
still reaping service-local child processes, such as WhatsApp bridge Chrome, if
they outlive the stop timeout. Browserctl-managed desktops and active Codex
app-server turns run outside the UI service cgroup. A Codex
turn is treated as restart-safe only when `/api/threads?scope=all` reports both
`runtime=codex-app-server` and `appServer=websocket` or `appServer=proxy`. First-time migrations from the
old in-process app-server remain conservative and wait until active work is idle
before enabling the separate Codex service. Use `--wait-active` to wait, or
`--allow-interrupt` only when the user explicitly accepts interrupting unsafe
running threads.

For public/stable production, prefer an exact tag. For dogfood/main tracking,
`main` or a specific commit is acceptable and should produce a release id like
`main-<short-commit>`.

After deploy, verify:

```bash
orkestr version --json
curl -fsS "$ORKESTR_BASE_URL/api/version"
orkestr-deploy status
```

The final report must include version, tag or release id, commit, channel,
deployment time, and rollback target if available.

## Phase 10: Sync Workers

After main is released:

- The versioned deployer runs a post-deploy safe worker sync by default
  (`ORKESTR_DEPLOY_SYNC_WORKERS=1`).
- Fast-forward workers that are ancestors of the released parent or `main`.
- Skip active workers, workers with local edits, and workers with unique
  unmerged commits.
- Do not rewrite workers that still have unique unmerged commits.
- For non-fast-forward workers, report the exact missing commits and leave them
  active for the next train.
- Push worker fast-forwards only when they are clean and the update is truly a
  fast-forward.
- Disable this deploy-time pass with `--no-sync-workers` or
  `ORKESTR_DEPLOY_SYNC_WORKERS=0` when intentionally keeping worker branches
  pinned for investigation.

This keeps workers current without hiding unfinished work.

## Final Report

Report:

- parent branch and target branch
- merged workers
- skipped workers and why
- dirty work that was checkpointed
- conflicts resolved
- tests run and results
- CI run URL/status
- release tag or release id
- deployed target, if any
- rollback command or previous release id
