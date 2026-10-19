# Frozen beta pair build plan

This is the Installation build owner's invocation checklist, not build evidence.
No build or service/provider start is performed by this document. Linux x86_64
only; both artifacts use release profile and version `2.0.0-beta.2`.

Before building, retain a private pre-execution receipt containing:

- Coordinator's exact full clean source commit including final Runtime assembly,
  Core ports, UI source and reviewed selected-service/manager corrections. Record
  the Git tree, clean status, Cargo manifests/lock/toolchain hashes. Verify actual
  workspace version is `2.0.0-beta.2`; do not relabel another version.
- Resolved Cargo wrapper, toolchain, Rust compiler, Cargo and wasm-bindgen paths,
  hashes and versions; installed wasm target. wasm-bindgen must be 0.2.129.
- Exact commands below, literal resolved environment, cwd, target/output paths and
  their isolation/lock ownership. No inherited provider/account/bootstrap values.
- One admitted wrapper build slot, at most four jobs; native then WASM sequentially.
  Use coordinator-assigned target under its lock. Do not create a second build
  lane or rebuild an already sealed identical pair.

The generic `candidate/build_pair.py` currently does not inject component-specific
`ORKESTR_V2_BUILD_IDENTITY`. Do not invoke it unchanged for this stamped pair.
Use separate native/web environments below and retain each exact environment.
The variables are explicit private build-plan inputs, not product defaults:

```
SOURCE=<full-frozen-commit>
CHECKOUT=<clean-frozen-checkout>
V2_CARGO=<authorized-absolute-wrapper>
CARGO_HOME=<existing-offline-cache>
RUSTUP_HOME=<existing-toolchain-home>
CARGO_TARGET_DIR=<assigned-locked-target>
BUILD_HOME=<fresh-private-build-home>
PAIR_OUT=<fresh-private-output>
BINDGEN_BIN=<installed-pinned-bindgen-directory>
BUILD_PATH="$BINDGEN_BIN:$CARGO_HOME/bin:/usr/bin:/bin"
```

Native command, cwd `$CHECKOUT/v2`:

```
env -i PATH="$BUILD_PATH" HOME="$BUILD_HOME" \
  CARGO_HOME="$CARGO_HOME" RUSTUP_HOME="$RUSTUP_HOME" \
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" CARGO_BUILD_JOBS=4 \
  CARGO_NET_OFFLINE=true V2_CARGO="$V2_CARGO" \
  ORKESTR_V2_BUILD_IDENTITY="ORKESTR_V2_BUILD_IDENTITY_V1|server|2.0.0-beta.2|$SOURCE|END" \
  "$V2_CARGO" build --release --offline --locked -p orkestr-v2-server
```

Web command, cwd `$CHECKOUT` (only after native succeeds):

```
env -i PATH="$BUILD_PATH" HOME="$BUILD_HOME" \
  CARGO_HOME="$CARGO_HOME" RUSTUP_HOME="$RUSTUP_HOME" \
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR" CARGO_BUILD_JOBS=4 \
  CARGO_NET_OFFLINE=true V2_CARGO="$V2_CARGO" \
  UI_BUNDLE_DIR="$PAIR_OUT/ui" UI_EXECUTION_CONTROLS=1 UI_SERVER_CANDIDATE="$SOURCE" \
  ORKESTR_V2_BUILD_IDENTITY="ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-beta.2|$SOURCE|END" \
  /bin/bash "$CHECKOUT/v2/apps/ui/scripts/bundle.sh"
```

Before handing artifacts to the root operator:

1. Preserve logs, exit statuses and post-build clean Git status. Copy the native
   executable into the fresh output; hash copied bytes and producer bytes.
2. Byte-verify the single exact component identity in native and web WASM. Seal
   same-source/version receipt with release/default server features and explicit
   web+execution-controls/source binding; include sorted UI size/hash inventory,
   inventory digest, complete migration SHA256/SQLx SHA384 inventory and actual
   architecture/glibc requirements. Refuse all mismatches; no RC qualification.
3. Compare the selected preparer's expected pair grammar with the sealed receipt;
   preserve any normalization as a separately hashed receipt, never replace the
   producer's receipt. Root owns provider-disabled setup and its private IDs.
4. Prepare final-path root-controlled service package with those exact bytes;
   retain full Package validation and outer receipt. External startup-closure
   collector/reverification is a separate root-owned prerequisite: the selected
   receipt's fixed dependencies alone are not transitive execution closure.
5. Return exact source/server/UI/receipt/package hashes. Service deployment,
   provider invocation and beta acceptance remain separate root-owned actions.

Current waiting inputs are the compiled Runtime assembly and final integrated
UI/source commit. No extra permission milestone is implied once that handoff and
existing resource admission are satisfied.
