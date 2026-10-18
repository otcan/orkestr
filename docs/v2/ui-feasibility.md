# UI first-slice feasibility and implementation handoff

Status: implementation admission active on 2026-10-18. Intake UI source is
authored; Rust/WASM compilation awaits coordinator-owned workspace and lock
resolution. This report does not establish a working UI or native application.
Baseline: plan `a7ba6d5999c570c21cc717d78c83cf53622c22c9`, product ADR 0003
at `2d48f841fea794c494b93c14db2d549c5eab9c89`.

## Framework and platform

Use Dioxus's supported mobile WebView renderer and shared Rust components with
CSS. Do not enable the experimental WGPU/native renderer. The official
[mobile guide](https://dioxuslabs.com/learn/0.7/guides/platforms/mobile/)
documents WebView support. Native packaging does not mean native UIKit widgets.

Authored manifest pin: `dioxus = "=0.7.3"`, with explicit web and mobile
features. The earlier research candidate was superseded by the reference-source
compatibility choice; this dependency set has not been compiled in this lane.
Resolve transitive versions with the coordinator and commit the shared lockfile
through its owner. Select one
renderer per build, with explicit web/mobile Cargo features. Keep privileged
server/runtime dependencies out of the UI graph; import Core's contracts.

The [official iOS bundling instructions](https://dioxuslabs.com/learn/0.7/tutorial/bundle/)
require macOS, Xcode, an iOS SDK/simulator runtime, and Rust iOS targets.
Use `aarch64-apple-ios-sim` on Apple Silicon and validate the selected simulator
architecture against the actual host/tooling. The mobile guide includes an
apparently inconsistent historical M1/x86_64 example; do not copy it as a
verified instruction. Record actual SDK, Rust, Dioxus CLI and simulator versions
when a macOS runner is available. `dx serve --ios` is an upstream example,
not a command verified for this repository.

Host probe: `uname -srm` returned Linux x86_64; `command -v dx`,
`command -v xcodebuild`, and `command -v xcrun` found no executables on PATH.
No packages, Apple targets, SDKs or CLI tools were installed. No cargo commands
were run while this lane was queued. Linux cannot provide the required iOS
simulator evidence. Signing, TestFlight and owner installation are outside this
slice; a macOS simulator build remains blocked, rather than passed or waived.

## Component and transport boundaries

Source is implemented in `v2/apps/ui`. Separate shell/navigation, conversation,
composer, run/status presentation and transport/projection modules. Use
Assistant, Projects, Attention, History and Settings navigation. A project
opens its canonical conversation; fast/deep/worker details appear under Work
rather than creating additional main chats. Missing optional integrations do
not block project creation. Resource readiness comes from the server; local
OXRM must say unverified/blocked until provisioner evidence exists.

Use Core's published fixture DTOs until the server exists. Do not invent a
second public schema or imply fixtures are durable storage. Fixture mode must
have a persistent visible synthetic-data label. Once available, use versioned
JSON HTTP commands and authenticated SSE against the actual server.

Core's published intake contract is pinned to
`e2de7312093fdffcd7a8b6111efa546af89bf929` (PR #78): DTOs in
`v2/crates/contracts/src/lib.rs`, routes/auth in `docs/v2/api-v0-intake.md`, and
synthetic JSON examples in `v2/fixtures/*.json`. API `contract_version: 0`,
event `schema_version: 1`, and SQLite migration `0001_intake.sql` are separate
version axes. The intake contract provides:

- Setup posts username/password credentials with `x-orkestr-bootstrap`.
  Session posts the same credentials and returns a Bearer token, token type,
  43,200-second expiry and the global canonical conversation ID.
- Commands use Bearer Authorization, with a same-origin Origin guard; no
  cookie session is currently offered. Keep the browser token in memory for
  this slice; reload requires sign-in. Bootstrap-token delivery to the owner
  needs a secure local setup flow, never a URL parameter or log entry.
- Projects list returns `projects` and `next_cursor`. Creation submits
  `client_request_id` and `name`; use returned project/conversation IDs.
  Resource states are `local_git: not_provisioned` and
  `local_oxrm: unverified`, not successful provisioning.
- Snapshot returns conversation ID, scope, messages, last sequence and next
  cursor, with `after`/`limit` pagination capped at 100. Bind field types and
  cursor handling to the published fixtures rather than guessing them.
- Message request/receipt remains canonical API v0. SSE accepts a sequence
  through `Last-Event-ID` or `after`. Browser EventSource cannot attach the
  required Authorization header: use authenticated fetch-stream parsing with
  cancellation, bounded buffers and reconnect. Never put the token in a query.

Implement against that exact published contract commit. A published response
shape alone does not prove server or client acceptance.

Read-only inspection of Core's published `v2/fixtures/*.json` and
`docs/v2/api-v0-intake.md` confirms seven synthetic JSON examples and these
additional integration constraints:

- Scope is tagged by `kind`: global or project with `project_id`.
- `message_accepted` events reference a message; fetch its text through the
  snapshot. Do not render an event payload as an assistant response.
- Finish snapshot pagination before SSE reconnect from the snapshot watermark;
  preserve that initial watermark across pagination. Handle `resync_required`
  by rebuilding the projection, and `session_expired` by requiring sign-in
  without clearing unsent input. No reconnect loop on expired credentials.
- The intake server has no run/session projections or cancel endpoint yet.
  Render runtime/Stop capability as unavailable rather than inventing busy
  sessions, cancellation results or an enabled no-op Stop button.
- Binding is loopback-only. An iPhone cannot reach a different computer's
  loopback API; remote/native device connectivity needs a separately reviewed
  transport/auth increment. Do not enable broad binding or CORS as a workaround.

All seven JSON files were parsed successfully with Python, without executing
Core code. This is fixture syntax inspection, not seven passing HTTP tests or
verification of Core's separately reported process probes.

Keep drafts keyed by canonical conversation identity, independently of stream
and request state. Typing remains enabled while a run is busy. Persisted
acceptance and rendered model text are separate states. Retain the same
client request key and submitted payload when retrying an uncertain request;
an edited follow-up receives a new key. Clear only the submitted draft revision
after acceptance, preserving text typed during the request. Never synthesize
acceptance from a local animation or network timeout.

Apply snapshots and events using authoritative sequence/message identities.
Deduplicate replay, reconnect from the last applied sequence, and explicitly
resnapshot on a stale cursor. Bound retained/rendered history and stream
buffers; pagination must preserve focus and scroll position. Connection loss
marks displayed status as stale rather than declaring a run stopped.

Stop calls the cancellation API directly. Show cancel requested separately
from confirmed cancelled, plus uncertain/already-dispatched effects. A rejected
or timed-out command cannot mark a run terminal. Completion labels come from
canonical state/evidence, never from assistant prose containing “done”.

## Native security and usability gates

The iOS app is a client of the self-hosted server, never the provider host.
Provider credentials and native provider session identifiers stay server-side.
Do not persist credentials in JavaScript local storage, URLs or logs. Native
device-token storage requires an audited Keychain boundary, revocation/logout,
and a server-supported device-auth contract before native auth is accepted.
The intake server uses Bearer auth rather than a browser cookie session;
retain the web token only in memory and honor the server's origin policy.
This intake mechanism does not satisfy the first-implementation browser-session/
CSRF acceptance requirement. Live browser auth integration remains blocked until
the original session/CSRF implementation or an independently reviewed contract
amendment is available. Memory-only token handling is an interim client design,
not evidence of that acceptance. Persistent browser token storage, server-side
revocation and device auth are not implemented.
Cross-origin WebView API access, TLS, session expiry and native reconnect need
explicit integration tests; do not weaken server origin policy to make a demo
work. The concrete native auth/Keychain bridge is pending, not implemented.

Keep drafts in memory initially; durable local drafts require an explicit
retention/storage decision. Opt-in memory remains a separate server operation.
Avoid exposing message text in background notifications or device logs.

| Gate | Required evidence | Current status |
|---|---|---|
| Web build | Pinned locked WASM build on exact PR head | Pending admission |
| Busy input | Type/edit/send during a 30-second fake deep turn | Pending implementation |
| Reconnect | Duplicate replay, stale cursor, offline retry, draft preservation | Pending implementation |
| History | 10,000 messages, bounded rendering and stable scroll/focus | Pending implementation |
| Stop | Canonical requested/confirmed/uncertain outcomes through real API | Pending server/UI |
| iOS build | macOS simulator build, exact versions and captured command result | Blocked: host/toolchain |
| Keyboard | Software/hardware keyboard, IME composition, multiline submit, safe area and rotation | Pending simulator/device |
| Accessibility | Labels, landmarks, focus order, VoiceOver, Dynamic Type, contrast | Pending browser/simulator/device |
| Lifecycle | Suspend/resume, auth expiry, cursor resync, retained unsent input | Pending native implementation |
| Native auth | Keychain storage, revocation, TLS/origin contract | Pending design and tests |

Announce bounded status changes through a polite live region, not every token.
Keep Stop keyboard-accessible and ensure stream updates do not steal composer
focus. Enter submission must respect IME composition; multiline editing needs
an explicit send action on touch devices. A mobile browser screenshot cannot
close any simulator or device gate.

## Next admitted work

Use the pinned Core contract/fixture commit, agree dependency and workspace changes
with the coordinator, then implement the shell, projection and composer tests.
Build/test only through the host-provided locked build wrapper with the assigned
isolated UI target/home. Report exact commit, commands, counts and CI separately
from runnable-server and native acceptance. No live inference is needed.

### Incremental intake source checkpoint

The live view now refreshes snapshots after its applied SSE cursor instead of
rescanning all historical input on each accepted-message event. It retains its
bounded projection and advances the replay cursor only after all snapshot pages
apply successfully. Explicit resync still starts from the beginning. History has
a separate bounded page projection with beginning, next-page and refresh controls;
live updates cannot replace the historical page being read. Pagination rejects
backwards watermarks, mismatched conversations and nonadvancing cursors.

These are source changes, not compiled UI acceptance. Four Node SSE bridge tests
pass; Rust/WASM validation still requires coordinator-owned workspace membership
and lock resolution. Browser auth/CSRF amendment, same-origin serving, browser
interaction and native gates remain pending. No macOS workflow allowlist change
was made; the unsigned job remains a proposal pending the parent policy review.
