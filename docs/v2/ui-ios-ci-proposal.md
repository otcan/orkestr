# Unsigned iOS CI proposal

Status: prepared, not enabled or executed. See
`v2/ci/ios-simulator.yml.proposed`. Linux is a current build-host blocker, not
a decision to defer iOS indefinitely. Simulator and physical-device acceptance
remain separate gates.

The repository's `scripts/security/workflow-policy.mjs` currently permits only
`ubuntu-latest` and `ubuntu-24.04-arm`. Consequently this macOS proposal would
fail `workflow_runner` if installed as a workflow today. Parent has granted the coordinator a narrow policy/test change for exactly
`macos-15` in `.github/workflows/v2-ios.yml` only. This grant is not a landed
policy change. Coordinator must route independent exact-head review;
this lane does not bypass policy or modify unrelated 1.x security code.

The candidate uses an ordinary GitHub-hosted `macos-15` runner, pinned checkout
SHA with persisted credentials disabled, exact PR-head checkout, contents-read
permission, no secrets, no cache or executable artifact download, bounded timeout
and per-PR/branch cancellation. Both PR base branches and push branches are
limited to `v2/**`; no dispatch or privileged trigger is proposed. Rust 1.99.1 and Dioxus CLI 0.7.3 are exact pins;
CLI installation uses its published lock. The authoritative application lock
remains coordinator-owned. No paid-service configuration or signing changes
are proposed. Runner availability/cost policy must be checked before enabling.

The runner label pins an OS family, not immutable Xcode/SDK contents. Record
actual image, Xcode, SDK and architecture and review compatibility with the
pinned CLI before promotion. The proposal selects the Intel simulator target `x86_64-apple-ios` and explicitly
requires `uname -m` to equal `x86_64`. An architecture mismatch fails before
installation, rather than silently selecting a different target. Actual runner
architecture and SDK support still need exact-head CI evidence.

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

Coordinator activation checklist: land the scoped policy exception and tests first;
then install this proposal at `.github/workflows/v2-ios.yml`. Prove rejection of
macOS in other workflow files and of `macos-latest`/self-hosted runners everywhere.
Run `npm run security:workflows` plus workflow/secret/dependency security tests,
obtain independent verification at the exact head, and require green exact-head
CI. This lane has not edited either policy or its tests. Checkout is the existing
reviewed action; no action inventory addition is proposed.

Policy candidate cross-check: `ba3aeb0e41a79cf3760431942ebd45cb6775291f`
recognizes the exact filename `v2-ios.yml`, not the proposal's current filename.
The uninstalled proposal matches its required `macos-15` runner and explicit
`v2/**` PR/push branch filters; it declares no tag filters, alternate trigger,
secrets, elevated permission or new action. Keep the file under `v2/ci/` until
independent policy review and exact-head CI pass and the coordinator authorizes
activation. This read-only policy comparison did not run the checker against
the proposal and does not establish policy or simulator acceptance.
