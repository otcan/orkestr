# LLM-Assisted Release Procedures

These procedures are the canonical operator path for release, isolation, and
live E2E work. Npm scripts remain useful command primitives, but they are not
the source of truth for deciding what to run, when to stop, or how to recover.

Use these procedures when a release touches runtime state, tenant isolation,
WhatsApp routing, browser desktops, timers, public demo VMs, deploy scripts, or
the release train itself.

## Operating Model

The agent must adapt to the live repository and runtime state:

1. Discover context with `orkestr whereiam --json`, `git status --short
   --branch`, and the relevant docs for the surface being changed.
2. Classify the change surface before choosing gates.
3. Treat npm scripts, Node scripts, shell scripts, and direct test invocations as
   primitives that can be run individually.
4. Inspect every failure and classify it before retrying.
5. Produce an evidence packet before signoff.

Do not hide decisions inside a single umbrella command. An umbrella command such
as `npm run pipeline:full` can be used as a convenience check only after the
agent has already decided that its included stages match the release surface.

## Evidence Packet

Every procedure finishes with a short evidence packet:

- `context`: branch, commit, dirty files, `orkestr whereiam` thread, target
  instance or local-only scope.
- `surface`: changed product areas and why each gate was selected or skipped.
- `commands`: exact commands run, start/end time, and pass/fail status.
- `artifacts`: paths to JSON summaries, e2e artifacts, logs, screenshots, or
  manual operator notes.
- `failures`: failure class, fix attempted, retry count, and residual risk.
- `signoff`: explicit completion criteria met, or the blocking condition.

Keep the packet public-safe. Do not include real WhatsApp ids, private
hostnames, access tokens, OAuth details, browser profile paths, or private
overlay paths.

## Failure Classes

Use these classes before deciding to retry:

- `product-bug`: deterministic code failure or broken assertion. Fix code.
- `test-bug`: fixture, timeout, or assertion no longer matches intended
  behavior. Fix the test only after confirming product behavior.
- `environment`: missing local dependency, unavailable Docker/Kubernetes,
  unavailable browser, or port conflict. Repair environment or record blocked.
- `auth-required`: Codex, WhatsApp, Gmail, Outlook, desktop, or broker auth is
  missing. Stop for operator action unless the procedure explicitly permits an
  attended path.
- `live-transport`: real WhatsApp or public URL path failed after preflight.
  Preserve artifacts and decide whether retry is safe.
- `operator-decision`: release scope, deploy target, bypass, or privacy tradeoff
  needs explicit user approval.

Retry only after the failure class implies a retry can produce new information.
Never retry real WhatsApp sends blindly; inspect the artifact and message
history first.

## Primitive Inventory

Stable primitives:

- `npm run build`, `npm run build:server`, `npm run web:build`
- `node --test ...` for targeted suites
- `npm run test:ci` or `node scripts/ci-test-runner.mjs`
- `npm run oss:boundary-check` or `node scripts/oss-boundary-check.mjs`
- `npm run test:tenant-isolation` for the named tenant isolation suite
- `npm run audit:isolation` or `node scripts/audit-isolated-demo-instance.mjs`
- `npm run smoke`, `npm run smoke:demo-vm`,
  `npm run smoke:k3s:oss-demo`
- `npm run e2e:whatsapp-real -- --execute ...`
- `npm run e2e:whatsapp-demo-onboarding -- --execute ...`
- `npm run release:regression -- --target NAME=URL ...`
- `orkestr instances --probe`, `orkestr update --release ...`

Convenience orchestration:

- `npm run pipeline:full`
- `npm run pipeline:full -- --plan`

Use convenience orchestration only after checking that it includes the necessary
live, isolation, deploy, and artifact requirements for the current release.

## Procedure: Local Release Gate

Use for normal local validation without live WhatsApp, live Kubernetes, or
deploy side effects.

LLM checkpoints:

1. Inspect changed files and classify surfaces.
2. Select the smallest deterministic checks that cover those surfaces.
3. Decide whether a full local gate is still needed after targeted checks.
4. Inspect failures and choose fix, narrower rerun, or blocked status.

Recommended primitives:

```bash
npm run build
npm run test:ci
npm run oss:boundary-check
npm run smoke:demo-vm
npm run smoke
```

Add direct targeted tests before the broad gate when the changed surface is
narrow. For UI changes, run `npm run web:build` and verify the generated web
bundle. For server-only changes, `npm run build:server` may be enough before
targeted Node tests.

Completion criteria:

- selected commands pass
- no unrelated dirty files were introduced
- evidence packet explains any skipped primitive

## Procedure: Tenant And OSS VM Isolation Gate

Use for changes to use control, scoped connector state, contained users, browser
profiles, WhatsApp routing, public demo VMs, tenant VM registry/provisioning, or
isolation docs.

LLM checkpoints:

1. Compare the change against `docs/containment-matrix.md` and
   `docs/route-security-matrix.md`.
2. Confirm whether the hard boundary is local-only, tenant VM, or demo VM.
3. Verify no private operator state is read directly.
4. Decide whether the audit must run against a live VM or can run locally.

Required primitives:

```bash
npm run test:tenant-isolation
```

Add when demo VM or public onboarding boundaries are touched:

```bash
npm run audit:isolation
npm run smoke:demo-vm
```

Completion criteria:

- tenant isolation suite passes
- audit passes or is explicitly blocked by missing live VM inputs
- containment and route-security docs still match behavior
- evidence packet states that shared-process checks are defense-in-depth, not
  the hard public isolation boundary

## Procedure: Real WhatsApp E2E

Use only when a release requires WhatsApp routing evidence. Release deploys use
WA2WA as the default gate: the live sender WhatsApp account sends to the
responder WhatsApp account with `--real-send`, and the responder side must route
the message into the dedicated release/E2E Orkestr thread. Do not ask for a
non-WA2WA E2E path unless the user explicitly changes the release gate.

Default automated non-release mode can still inject inbound test messages into
the responder account so the sender account stays isolated. That is not the
release deploy gate.

LLM checkpoints:

1. Confirm the user asked for a real transport run or a release/deploy requires
   it.
2. Preflight target thread, chat, responder account, public URL, and desktop
   availability. Use a dedicated E2E/test/onboarding binding; a normal
   production/project chat requires the explicit `--allow-production-binding`
   escape hatch.
3. For release deploys, choose WA2WA `--real-send` with the `sender` and
   `responder` accounts. Use default responder injection or attended
   `--manual-send` only when the requested test is not a release deploy gate.
4. After a failure, inspect the JSON artifact before any retry.

Primitive:

```bash
npm run e2e:whatsapp-real -- --execute \
  --api-base <api-base> \
  --orkestr-home <orkestr-home> \
  --thread <thread-id> \
  --chat-id <chat-id> \
  --real-send \
  --sender-account sender \
  --responder-account <responder-account> \
  --artifact <artifact-path>
```

Attended mode uses `--manual-send` and `--sender-contact`. Live automated sender
transport uses `--real-send --sender-account <sender-account>`.

Completion criteria:

- artifact records account readiness, inbound routing, assistant reply delivery,
  and any enabled desktop/timer checks
- no duplicate real sends were made without inspecting prior state
- public evidence omits real chat ids and phone numbers

## Procedure: Demo Onboarding E2E

Use for isolated OSS demo VM releases where Orkestr sends a direct onboarding
message to a target phone-derived chat through the broker/router.

LLM checkpoints:

1. Confirm the target is a direct phone number, not a raw stored chat id.
2. Confirm broker public base URL is configured and not localhost.
3. Confirm the fresh instance UUID is present in the setup URL.
4. Inspect the artifact for stale instance ids, local URLs, or leaked bridge
   state.

Primitive:

```bash
ORKESTR_CONNECT_PUBLIC_BASE_URL=<public-connect-base> \
ORKESTR_REAL_WA_DEMO_PHONE_NUMBER=<target-phone> \
npm run e2e:whatsapp-demo-onboarding -- --execute \
  --artifact <artifact-path>
```

Completion criteria:

- setup URL is `/i/<fresh-uuid>/setup`
- unknown UUIDs do not route
- direct outbound onboarding reaches the phone-derived chat
- artifact shows no OSS-side WhatsApp account, bridge URL, or bridge token
  requirement

## Procedure: Release Train Deploy

Use only after local checks and required live E2E evidence pass.

LLM checkpoints:

1. Reconcile parent and worker branches according to `docs/release-train.md`.
2. Confirm release target, tag/ref, deploy channel, and instances.
3. Confirm whether real WhatsApp E2E is required; deploys require it unless the
   user explicitly approves the emergency bypass.
4. Probe instances before deploy and classify skipped instances.
5. Watch CI or equivalent remote checks after push.

Recommended primitives:

```bash
orkestr instances --probe
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel>
```

Release deploys fan out by default to every broker-listed instance that is
`releaseTrainEnabled` and has a deploy command. Use the explicit flag when you
want the default to be visible in logs:

```bash
orkestr update --release --ref <tag-or-main-or-sha> --channel <channel> --all-instances
```

Use `--no-all-instances` only for an intentional local-only deploy.

Completion criteria:

- local gate evidence is attached
- CI or remote checks pass
- deploy target reports intended version
- post-deploy interruption scan is clean

## Procedure: Post-Failure Recovery

Use after failed release checks, failed live E2E, interrupted deploys, or unclear
runtime state.

LLM checkpoints:

1. Stop new side effects until the failure class is known.
2. Preserve logs and artifacts.
3. Inspect runtime health with Orkestr APIs rather than private state files.
4. Decide whether to repair, retry, roll back, or ask for operator action.

Useful primitives:

```bash
git status --short --branch
orkestr whereiam --json
orkestr instances --probe
orkestr status
orkestr timers list
```

For thread-specific recovery, use Orkestr thread controls and documented APIs.
Do not read connector tokens, WhatsApp session state, browser profiles, or
private overlay files directly.

Completion criteria:

- failure has a class and owner
- side effects are known
- next action is either fixed and verified, blocked on operator input, or rolled
  back with evidence
