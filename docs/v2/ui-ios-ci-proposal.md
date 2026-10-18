# Unsigned iOS CI proposal

Status: prepared, not enabled or executed. See
`v2/ci/ios-simulator.yml.proposed`. Linux is a current build-host blocker, not
a decision to defer iOS indefinitely. Simulator and physical-device acceptance
remain separate gates.

The repository's `scripts/security/workflow-policy.mjs` currently permits only
`ubuntu-latest` and `ubuntu-24.04-arm`. Consequently this macOS proposal would
fail `workflow_runner` if installed as a workflow today. Coordinator must route
a narrowly reviewed runner allowlist and corresponding policy-test change;
this lane does not bypass policy or modify unrelated 1.x security code.

The candidate uses an ordinary GitHub-hosted `macos-14` runner, pinned checkout
SHA with persisted credentials disabled, exact PR-head checkout, contents-read
permission, no secrets, no cache or executable artifact download, bounded timeout
and per-PR cancellation. Rust 1.99.1 and Dioxus CLI 0.7.3 are exact pins;
CLI installation uses its published lock. The authoritative application lock
remains coordinator-owned. No paid-service configuration or signing changes
are proposed. Runner availability/cost policy must be checked before enabling.

The runner label pins an OS family, not immutable Xcode/SDK contents. Record
actual image, Xcode, SDK and architecture and review compatibility with the
pinned CLI before promotion. `aarch64-apple-ios-sim` assumes an Apple Silicon
runner; reject an architecture mismatch rather than silently changing targets.

The proposed job compiles the real shared client for an unsigned simulator
target. It does not yet build/boot/launch a simulator app bundle. Exact-version
`dx` bundle flags, chosen simulator runtime/device, bundle identifier and boot/
launch checks must be verified before adding that next step. Keep native
navigation, keyboard/IME, VoiceOver, suspend/reconnect, credential storage and
physical-device transport/auth acceptance pending until measured. A successful
cross-compile must never close those gates.

No workflow has been installed/launched, SDK/CLI installed, macOS compute
provisioned, signing credential accessed, or TestFlight/deploy step added by
this proposal.
