# Build identity: independent review

Reviewed Installation `0a69dea53d9406827fff526d572a14560631dc57` and test-only successor `883e0f3274b12c53a35e0a0b069dd2d1dcfb57ce`.

No bounded source blocker in byte-only artifact identity verification. Exact server/web component, workspace version, source, hashes and inventory must agree. Missing, malformed, conflicting or unknown records refuse; repeated identical records are allowed. Historical v1 integrity is explicitly limited to the pinned upgrade predecessor. Embedded bytes are integrity metadata, not signed build attestation.

Independent rerun: embedded-identity tests 10/10 and mocked version-probe tests 2/2 passed. New `v2/acceptance/package_identity_noexec.py` passes full synthetic assembly/verification and source/version relabel refusals with every `subprocess.Popen` forbidden. Set `ORKESTR_V2_REVIEW_SOURCE_ROOT` to an owned exact export of the reviewed successor to reproduce. No supplied binary executes in this oracle.

Early version behavior is **pending**: exact successor main/lib do not register the identity leaf or handle version arguments before HOME/config initialization. The newly added binary integration test is an unexecuted acceptance gate, not evidence of passing behavior. Request a registered successor before executing a trusted, provenance-qualified owned binary. `probe_version.check` intentionally executes a binary for explicit acceptance; package verification itself does not call it. Integrity metadata alone does not establish trust to execute an arbitrary supplied artifact.

No Rust CLI test, package launch, native/Docker acceptance, account refresh or provider credit. Authored no-execution oracle requires another lane's review.
