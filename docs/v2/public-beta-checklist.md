# First public V2 Linux beta release checklist

Planned tag: **v2.0.0-beta.4**, continuing embedded beta.3. The earlier informal
“beta 1” meant the first public beta; never relabel beta.3 artifacts as beta.1.
This checklist does not authorize tagging, publication or deployment.

## Source and scope

- [ ] Freeze a reviewed exact public commit with clean Git status, matching
  Cargo workspace/lock versions and matching embedded server/web identities.
- [ ] Confirm Linux x86_64, Compose, web UI, user's own Codex and Claude CLI
  login, Fast/Deep, conversations, timers/digests, review/Stop and provider handoff.
  Tracker is optional; desktop and other platforms are deferred.
- [ ] Review public dependency/provider pins, redistribution terms, image
  inventory and security findings under the ordinary release policy.
- [ ] Follow the [release train](../release-train.md), including corresponding
  branch alignment. Preserve independent desktop work.

## Automated clean-install evidence

- [ ] Exact-source Rust, browser and packaging CI green; retain run links.
- [ ] `v2-image.yml` builds from anonymous public source and pinned base images,
  with no host state, real accounts, registry credentials or secret build args.
- [ ] Fresh named volumes: real web index/WASM, exact build identity, setup
  refusal without bootstrap, synthetic owner/login and conversation creation.
- [ ] Both pinned official CLI binaries present. Missing login refuses
  configuration; logs show `provider_login_required`. No inference in CI.
- [ ] Restart preserves the synthetic owner/conversation. Acceptance cleanup
  touches only its own resources; evidence contains no credentials.
- [ ] Export #265 tarball from the same build; verify inventory/checksums and
  clean native launch. **Gap:** bundle alone does not install the provider manager.
  Qualify a native setup path or explicitly approve/document this limitation
  before advertising tarball feature parity.

## Manual owner acceptance after login

Use a fresh disposable instance and the owner's own CLI logins. Keep credentials
in the named credentials volume. Private receipts stay private; public evidence
contains only counts/status and fake or redacted identifiers.

- [ ] In-container Codex device login and Claude login succeed. `configure`
  binds authenticated owner scope; generated package passes ordinary source,
  custody, closed inventory and hash validation without waivers.
- [ ] Real first Codex answer and follow-up; Fast and Deep observed separately.
- [ ] Real first Claude answer and follow-up; no unexpected account/API-key
  fallback. Check exact pinned CLI compatibility, not only current documentation.
- [ ] Review-before-accepting and explicit acceptance work. Stop joins/reaps
  original running work and confirms Stopped.
- [ ] Provider handoff carries the reviewed summary once and preserves history;
  the next fresh input gets one answer on the selected provider.
- [ ] One future timer/digest produces an accepted result once. Pause afterward.
  Restart preserves the timer and prevents duplicate work.
- [ ] Shutdown/restart preserves history, native continuity and consumed budget;
  ambiguous work refuses and follows supported reconciliation.
- [ ] Stopped-state backup/restore of state and credentials tested; the beta's
  upgrade/rollback policy is explicitly documented.

## Publish only after owner GO

- [ ] Present remaining fresh-install gaps and exact candidate evidence to the
  owner. Obtain explicit GO for the source, tag and artifacts.
- [ ] Verify `v2.0.0-beta.4` is unused and embedded version agrees. Never move
  an existing tag or relabel previous artifacts.
- [ ] Tag/release via the release train; publish the approved image digest and
  attach the exact tarball/checksums/receipt. Build CI has no registry write
  permission and does not publish.
- [ ] Update quickstart to the published tag/digest and test those exact commands
  on a fresh machine.
- [ ] Release notes state supported/deferred targets, synthetic vs real
  acceptance, limitations and private bug-report instructions.

No boxes are prechecked: source changes and image builds do not prove an owner's
provider login or first model answer succeeded.
