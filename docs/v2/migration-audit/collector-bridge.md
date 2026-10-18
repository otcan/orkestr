# Synthetic Store-to-collector bridge

`v2/migration/store_collector_bridge.rs` is Migration-owned integration-test
source against the documented registered Store export API at reviewed helper
commit `e975f5a1e5c9fb8e14cb8cd47859242efd9b7037`. It creates a fresh synthetic
Store under an admission-owner-supplied isolated ORKESTR_V2_HOME. It accepts no
source database path, existing credentials or real export input. Synthetic live
intake seeds its fixture only; historical migration must never use that path.

The test captures three synthetic messages (including Unicode and DEL), writes
a fourth after capture, emits the stable pages and expected pre-cut snapshot,
then captures a second cut and proves current session revocation refuses its
second page. It prints a single MIGRATION_BRIDGE-prefixed JSON line containing
only synthetic expected/pages/incomplete-prefix and a refusal assertion. No
session token or receipt is printed. The database is closed and removed on
success; panic cleanup belongs to the isolated admission scratch directory.

`v2/migration/collector_bridge.py::verify_bridge` consumes that parsed synthetic
JSON object without I/O. It invokes the actual collect_pages implementation,
requires exact equality with the expected cut, and requires the refused prefix
to fail specifically as incomplete, not malformed or complete. It returns a
synthetic digest and pass result without retaining a partial export. Three new
Python tests cover success/no mutation, changed cut, incorrectly complete
prefix, missing/malformed prefix and missing refusal assertion.

## Admitted execution checkpoint

Core owns registration/reexports. An admitted builder should install this source
as an integration test only in a disposable source export of the registered
candidate, using existing public application/contracts/store dependencies plus
tokio/uuid/serde_json. No shared manifest, registration or workflow was edited
by Migration. The builder should run the selected integration test with output
capture, extract exactly one MIGRATION_BRIDGE line, parse its JSON, and call
verify_bridge using Migration's committed Python source. Record both exact
commits and source/executable hashes privately. Do not treat unrelated Rust tests
or hand-authored Python input as execution of this bridge. Do not point this test
at an existing product home or adapt its printing to real data.

Exact registered Core `18bcf306cf14ebe16e9385e630d18e05cf3296eb` was
exported to disposable source; the only addition was the bridge integration test
from Migration `2a07ab2659452167d51b4768900ab43043e6ada8`. Using the admitted
wrapper, unique target and fresh isolated home, this command passed:

```text
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --test store_collector_bridge -- --nocapture --test-threads=1
```

Rust: 1 passed, 0 failed/ignored; test execution 0.09s after compilation.
Exactly one actual MIGRATION_BRIDGE line was parsed and passed to verify_bridge
extracted via git show from the same committed Migration revision (including
its collector and snapshot dependencies). Result: PASS, partial_discarded=true.
The collected pre-cut messages matched exactly, excluding the post-cut write;
the revoked second collection was refused and its prefix rejected as incomplete.
Source, executable and verifier hashes plus terminal result are retained in a
private receipt outside this repository; no local paths or generated IDs are
published. Source SHA256 for the installed bridge:
`528fbf939deb84d572d6cb5c45f8ce5e09b21fe55fb8e13a26b086be76cb797a`.
Executable SHA256:
`7a0748e85ed7b5b30fd776c9e0e6405c91e05bba2b51345bfb21b60d53632d6d`.
Workspace manifest, lockfile and store manifest were compared byte-for-byte with
the exact Core commit and remained unchanged. No shared checkout was edited.

Formatting/lint for this new bridge remain **unexecuted**. The Python suite
previously passed 88/88, including three verifier tests. This checkpoint now
adds actual synthetic Rust-to-Python execution; it does not establish live reads,
imports, providers, dormant apply, rollback or multi-authority consistency.
This bridge does not own the separate untrusted-worker OS boundary. Push and CI
remain unexecuted.
