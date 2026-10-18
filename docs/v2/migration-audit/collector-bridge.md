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

## Admission and exact execution still required

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

Rust compilation, formatting/lint and actual Rust-to-Python execution are
**unexecuted** here: registration and build admission remain external. The Python
suite passes 88/88, including three verifier tests; this is only synthetic
Python evidence. No live reads, imports, providers, dormant apply, rollback or
multi-authority consistency claim is made. This bridge does not own the separate
untrusted-worker OS boundary.
