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
- The release train owns branch alignment after `main` moves. It must not report
  success while corresponding worker or release branches are merely "behind" the
  released commit and could have been fast-forwarded safely.

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
- Deployment target: the release train default is the local host plus every
  broker-listed instance that host config marks `releaseTrainEnabled` and gives a
  deploy command. Do not invent private hostnames; the concrete instance list
  must come from private host config or broker state.

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

The release train owns tests. Use
[LLM-assisted release procedures](llm-assisted-release-procedures.md) to choose,
run, and recover checks according to the changed surface. Npm scripts are
command primitives, not the decision authority.

The agent must produce an evidence packet that states which surfaces changed,
which checks were selected, which checks were skipped, and why. A broad
umbrella command such as `npm run pipeline:full` may be used as a convenience
check only after the agent confirms that its planned stages match the current
release.

Minimum primitive guidance:

- server/build changes: `npm run build:server`
- web/UI changes: `npm run web:build`
- runtime/install/deploy changes: targeted Node tests plus shell syntax checks
- tenant isolation, use-control, scoped connector, browser profile, or contained
  user runtime changes: `npm run test:tenant-isolation` and the
  [tenant isolation release checklist](tenant-isolation-release-checklist.md)
- broad release train: `npm run build` and `node --test` or the repo's CI runner
- smoke-sensitive deploy changes: `npm run smoke`
- protected/public target checks: `npm run release:regression -- --target
  local=http://127.0.0.1:$ORKESTR_PORT --allow-auth-blocked`
- optional real WhatsApp/OAuth/desktop/timer checks:
  `npm run e2e:whatsapp-real -- --execute --real-send --sender-account sender
  --responder-account responder --thread <thread-id> --chat-id <chat-id>
  --isolated-runtime`.
  See `docs/real-whatsapp-e2e.md`; this sends real WhatsApp messages and must be
  opt-in. It is not a release/deploy requirement.
- isolated demo VM releases: `npm run audit:isolation` plus
  `npm run e2e:whatsapp-demo-onboarding -- --execute` with a direct target phone
  number, as described in `docs/isolated-oss-demo.md`.

Deploys do not require WA2WA real WhatsApp E2E. Demo deploys require an
isolation audit unless the user explicitly approves the isolation-audit bypass.
Record any bypass in the evidence packet.

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

Immediately after `main` is pushed, apply the no-drift invariant:

- Fast-forward and push every clean corresponding worker or release branch whose
  tip is an ancestor of the released commit.
- Do not rewrite, reset, or force-push branches with unique unmerged commits or
  local edits.
- Refresh Orkestr git state after the pushes and verify the parent and worker
  WebUI counters report no parent or remote drift for every branch that was
  safely fast-forwarded.
- If any corresponding branch cannot be fast-forwarded, report its branch name,
  local dirty state, unique commit count, and missing released commit before the
  train can be called complete.

Then watch CI. Prefer the repository's standard CI visibility:

- If GitHub CLI is available and authenticated, use `gh run list` and
  `gh run watch`.
- Otherwise, inspect the remote CI status through the configured provider or ask
  the user for the CI link.

The release train is not complete while CI is pending. If CI fails, fix clear
failures and repeat the release checks. Escalate only when failure ownership is
unclear.

## Phase 9: Deploy

Classify code-only versus state-changing releases before activation. Hosts using
scheduled backups must follow [deployment backup policy](deployment-backup-policy.md):
nightly state archives, a freshness gate for code-only updates, and a mandatory
fresh backup via `--state-change` for migrations or other durable-state changes.
Never use `--no-backup` for a state-changing release.

Deploy only after local release checks and CI pass, unless the user explicitly
requests a pre-CI deploy.

Use the versioned deployer:

```bash
orkestr instances --probe
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel>
```

### Release provenance gate

The versioned deployer binds each install to the CI result of the exact commit
it resolved (ORK-519). Right after `--ref` is resolved to a commit, and before
any build or activation, `scripts/release-provenance/deploy-gate.mjs` (the copy
shipped with the *running* deployer, never the candidate's) reads
`/repos/{owner}/{repo}/commits/{sha}/check-runs` and requires every check in
`scripts/release-provenance/release-policy.json` to be completed with
conclusion `success`: `syntax`, `secret-scan`, `secret-policy`,
`dependency-advisories`, `dependency-policy`, `build`, `smoke`, and at least
four `test (N)` shards, all from one workflow run whose `head_sha` matches.
`skipped` is not success.

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| `ORKESTR_DEPLOY_REQUIRE_CHECKS` | `enforce`, `warn`, `off` | `enforce` | Missing, failed, pending checks, head-sha mismatch, a non-GitHub source, or an unreadable API stop the deploy with exit `77`; `warn` logs and continues. |
| `ORKESTR_DEPLOY_ARTIFACT_PROVENANCE` | `off`, `warn`, `enforce` | `warn` | Reads the run's `runtime-dist` artifact metadata (id, digest, expiry) and attestation presence; with a token, downloads it, checks the archive digest, and compares its content manifest (`server`, `launcher` subtrees) with the locally built `dist`. `enforce` requires a token and fails closed; it never silently falls back to an unverified local build. |
| `ORKESTR_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | read-only token | unset | Optional for public repositories (unauthenticated API, 60 requests/hour); required for artifact download. Put it in the env file, never on the command line. It is never logged or recorded. |
| `ORKESTR_DEPLOY_PROVENANCE_REPO` | `owner/repo` | derived from `ORKESTR_REPO_URL` | For mirrors. `git@github.com:owner/repo.git`, `ssh://` and `https://` remotes are parsed automatically. |

Attestation signatures are verified with `gh attestation verify` only when the
GitHub CLI is installed and the artifact was downloaded; otherwise the record
says `attestation_unverified` (or `attestation_present_unverified` when the API
lists an attestation for the digest). CI creates the attestation in the
`provenance` job, only for `push`/`workflow_dispatch` builds, with
`actions/attest-build-provenance` over the `runtime-dist` archive digest and the
`runtime-dist-manifest` content manifest.

After the build, the gate computes the installed-tree digest (`dist` and the
release directory without `node_modules`) with the same
`scripts/release-provenance/content-manifest.mjs` used in CI, and records the
result under `provenance` in `release-manifest.json` and in the deployment
history event: CI run id/url, required check set and conclusions, gate modes and
result, artifact name/id/digest, attestation status, and tree digests. Rejected
deploys get a `rejected` history event. `rollback` is never gated; it reuses an
accepted release and copies that release's recorded provenance into the history.

Break-glass: set `ORKESTR_DEPLOY_REQUIRE_CHECKS=warn` for one deploy and record
the reason in the evidence packet. The deployer gate does not replace
repository rules: required status checks and branch protection on `main`
(ORK-478) are still a repo-admin setting, as are the trusted signer policy for
attestations and the token the host uses for artifact download.

### Deploys started by an agent turn

A release train run from inside an Orkestr thread (a Codex or Claude Code turn)
must use `--detach`:

```bash
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel> --all-instances --wait-active --detach
orkestr update status --deploy-id <id>
```

`--detach` refuses to start while another `orkestr-deploy-*` or
`orkestr-release-*` unit is active, then runs the deployer in a transient
`orkestr-deploy-<id>` systemd unit (through `sudo -n` when not root). The deploy
therefore outlives the service restart and the requesting turn. The calling
thread (`--thread <id>`, or resolved from the current directory; `--no-thread`
skips it) is excluded from the active-work guard, gets a short "deploy started"
notice, and receives the final report once the restarted service answers:
release id, smoke/health/exposure checks, instance fan-out and worker sync. The
result and log stay in `/var/tmp/orkestr-deploys/<id>/`
(`ORKESTR_DETACHED_DEPLOY_DIR`). A detached deploy exits `75` from the deployer
when another deploy holds the lock, instead of the legacy silent `0`.

Claude Code turns run detached from the UI service by default
(`ORKESTR_CLAUDE_DETACHED_TURNS=0` restores the legacy stdio pipe). Their
stream-json output is written to a per-turn log under
`$ORKESTR_HOME/runtimes/claude-code/turns/`, and the restarted service reattaches
to a turn that is still running, or replays one that finished while it was down,
so the final answer is delivered exactly once. When Orkestr runs as root under
systemd, each turn is started in its own transient `orkestr-claude-*.scope`, so
a service with `KillMode=control-group` does not kill it on restart
(`ORKESTR_CLAUDE_DETACHED_SCOPE=0|1` overrides the automatic choice). The
active-work guard treats scoped turns (`claudeTransport=detached`) as
restart-safe, like Codex app-server turns over websocket or proxy; unscoped
(`detached-unscoped`) and legacy piped Claude turns remain unsafe.

When a central broker owns multiple Orkestr instances, the release train must
inventory them before deployment with `orkestr instances --probe`. Runtime state
may list additional instances in `release-instances.json` or through
`ORKESTR_RELEASE_INSTANCES_FILE`; keep real hosts and deploy commands in that
private state, not in the OSS repo. Release deploys fan out by default after the
local host passes health checks, but only to instances that are explicitly marked
`releaseTrainEnabled` and have a deploy command in the broker registry.

Use `--all-instances` when you want the default fan-out to be explicit in logs:

```bash
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel> --all-instances
```

Release fan-out deploys and post-deploy connectivity checks run with bounded
parallelism by default. Set `ORKESTR_RELEASE_FANOUT_CONCURRENCY=1` for strictly
serial fan-out, or raise it for large instance sets after confirming the host can
handle the parallel restarts and health checks.

Use `--no-all-instances` only for an intentional local-only deploy. Skipped,
disabled, or commandless instances are still visible in the broker deploy log.

For WhatsApp-routed instances, require the connector accounts that must be live
after restart:

```bash
ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS="sender,responder" \
ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND='orkestr whatsapp accounts reconnect responder >/dev/null 2>&1; orkestr whatsapp accounts reconnect sender >/dev/null 2>&1' \
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel> --all-instances
```

If a deployment uses a single stable routed account and separate skill-only
WhatsApp accounts, require only the routed account:

```bash
ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS="sender" \
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel>
```

Skill-only accounts must be checked by their own local skill commands and must
not be added to the release train account gate.

The account gate retries longer than generic HTTP connectivity because WhatsApp
Web sessions can take time to reattach after the service restart. Tune with
`ORKESTR_RELEASE_WHATSAPP_ACCOUNT_ATTEMPTS` and
`ORKESTR_RELEASE_WHATSAPP_ACCOUNT_RETRY_DELAY_MS` when needed. If a routed
instance uses an external bridge with slow health responses, tune the service
environment with `ORKESTR_WHATSAPP_BRIDGE_STATUS_TIMEOUT_MS`.

For extracted WhatsApp deployments, run the bridge as the standalone
`orkestr-wa` service and point Orkestr instances at it with
`WHATSAPP_BRIDGE_MODE=external`. The service/readiness contract and the
no-copy migration path for carrying an existing linked WhatsApp Web login are in
[`docs/orkestr-wa-service.md`](./orkestr-wa-service.md). Use
`node scripts/orkestr-wa-readiness.mjs --bridge-url <url> --require-routing-policy --require-access-policy --account sender --account responder`
as the direct service gate when validating the bridge before restarting
dependent Orkestr instances. The gate must confirm both account routing and the
client access policy so a demo release cannot silently fall back to a shared
or unrestricted WhatsApp service.

Versioned deploys are no-interrupt by default. On current host-native installs,
Codex app-server runs as its own service and Orkestr talks to it through a short
proxy connection, so UI/API restarts do not stop active Codex turns. The deployer
still writes a drain marker before restart so new UI, WA, and timer inputs queue
instead of starting new turns during the deploy window. The drain marker stays
active until the new UI/API process passes health checks; startup recovery
defers while that marker is active so continuing Codex app-server turns are not
misclassified as restart interruptions. The deployer also writes a versioned
systemd drop-in that makes the API `node` process the service main process; this
avoids `npm start` wrapper orphans. The systemd unit uses `KillMode=process` so
the release restart gives the UI/API process a normal shutdown window without
killing service-local tmux/Codex children that are still active. WhatsApp bridge
Chrome cleanup is handled by the local bridge orphan-profile recovery path
instead of by UI service shutdown. Browserctl-managed desktops and active Codex
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

For any deploy with a public app URL, `orkestr-deploy` also runs a no-cookie
public exposure gate after the service restart. The gate must observe `401` or
`403` from private routes including `/api/threads`, `/api/users`, `/api/timers`,
`/api/browser-sessions`, `/api/desktops/leases`, `/api/connectors`, and
`/api/whereiam`. A `200` from any of those routes means the deploy is unsafe and
must not be reported complete. Disable this only for disposable local tests with
`ORKESTR_DEPLOY_EXPOSURE_CHECK=0`.

The deployer exits `3` when the local release is healthy but one or more
remote fan-out instances failed (`ORKESTR_DEPLOY_REMOTE_PARTIAL_EXIT_CODE`), so
callers can tell this apart from a failed local deploy.

The final report must include version, tag or release id, commit, channel,
deployment time, and rollback target if available.

## Phase 10: Sync Workers

After main is released:

- The versioned deployer runs a post-deploy safe worker sync by default
  (`ORKESTR_DEPLOY_SYNC_WORKERS=1`).
- Fast-forward workers that are ancestors of the released parent or `main`.
- Fast-forward corresponding release branches by the same rule when they only
  trail the released commit.
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

## Automated Single-Ref Release

`orkestr release-train` automates the common case where one ref (usually
`main`) is already pushed and only needs checking, CI confirmation, deploy and
branch alignment. It never pushes the release ref and never force-pushes.

```bash
orkestr release-train check [--ref main] [--repo path] [--json]
orkestr release-train ci --sha <sha> [--wait] [--timeout-min 30] [--json]
orkestr release-train deploy --sha <sha> [--channel main] [--thread id|--no-thread]
orkestr release-train sync-branches --sha <sha> [--path-prefix p] [--dry-run] [--json]
orkestr release-train run [--ref main] [--thread id|--no-thread]
```

- `check` resolves the ref, creates a fresh temporary `git worktree` of that
  exact commit under the system temp dir (its own `npm ci --ignore-scripts
  --no-audit`, never a shared or symlinked `node_modules`), runs the WhatsApp
  media-id patch, `npm run build`, `npm run launcher:build`, `npm run test:ci`
  with a short `TMPDIR`, and the dependency advisory scan for that commit, then
  removes the worktree.
- `ci` uses the provenance verifier to require the release policy's checks for
  the exact commit; `--wait` polls while checks are missing or pending.
- `deploy` requires recorded `check` and `ci` success for the sha, refuses while
  an `orkestr-deploy-*`/`orkestr-release-*` unit is active or while any active
  thread other than the calling one is not restart-safe (or the active-work
  report is unavailable), then launches the detached deploy with
  `--all-instances --wait-active`.
- `sync-branches` fast-forwards every clean worktree branch (an untracked
  `node_modules` entry is ignored) whose tip is an ancestor of the sha and pushes
  them in one `git push origin`; dirty or diverged branches are reported with
  their unique and missing commit counts and make the command exit non-zero.
- `run` chains check, `ci --wait` and deploy and stops at the first failure.

Results are recorded per commit in `ORKESTR_RELEASE_TRAIN_STATE_DIR` (default
`$ORKESTR_HOME/release-train`), including the check log and the advisory report.

### Dependency advisory watch

`node scripts/security/dependency-advisory-watch.mjs` scans the current
`origin/main` lockfile in a temporary worktree with the advisory scanner and
exits non-zero with a short summary when the scan is blocked or new high or
critical advisories appeared since the last run (state in
`ORKESTR_ADVISORY_WATCH_STATE_DIR`, default `$ORKESTR_HOME/advisory-watch`).
`--fix-branch [--branch-name name]` creates a local branch that runs `npm update
--package-lock-only --ignore-scripts` for the affected transitive packages (and
bumps exact direct pins only within the same major), commits it, rescans, and
reports whether the block clears. It never pushes.

Schedule it with an Orkestr timer from a private overlay, for example a daily
timer whose command is:

```bash
node scripts/security/dependency-advisory-watch.mjs --repo /path/to/orkestr-checkout --json
```

and route a non-zero exit to the release owner's thread.

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
