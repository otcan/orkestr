# Attachment storage and UI verification

Independent bounded review on 2026-10-19.

## Exact sources and execution

- Core `9cd9268234f52581de260681bf926be9d77968ef`: unchanged complete Git export, isolated Cargo target, required `v2-cargo`, offline and locked, `fixture-test-controls`. Filter `attachment` passed 12 tests, including the supplied four SIGKILL windows and eight fresh retry executions. Filter `preflight::tests` passed 10 tests, including populated prefixes 14/17/31/33/36/37 to 38, row/checksum/FK preservation and copy refusal.
- UI CI capture `78f6aa8cc5079b4cae948e0b031eda6b0b64cd17`: exact exported CI helpers and fixtures, 13 focused Node tests passed; runner syntax check passed.
- UI inert consumer `93e1072debefc8598b9167d0d75b102371a12c6d`: exact exported attachment helpers, 18 Node tests passed.

Initial invocation failures are retained separately: the Rust substring filter selected two metadata tests requiring an unset isolated-home variable, and the initial Node export omitted required canonical fixture files. Supplying that environment and exporting the unchanged fixtures resolved these setup failures without source or assertion changes.

## Source findings

No bounded source blocker found. Attachment writes authenticate the exact current credential under `BEGIN IMMEDIATE` before historical receipt lookup. Identical import replay returns the original receipt without rewriting removed bytes. Removal leaves tombstones. Export/download validate bytes from a fixed read snapshot and recheck current authentication before returning. Inert descriptors cannot supply bytes or enter the active aggregate; fresh copied references cannot claim target message identities.

The supplied process parent checks equality of selected complete table rows before commit, durable change after commit, and inert exact retries in new processes. Its postcommit oracle is not an explicit expected-row delta, and its selected tables are not every database table. These tests independently execute supplied probes; they are not independently authored probes or HTTP acceptance. Authentication cannot recall bytes after the final successful check.

The hosted CI helper observes one actual Send fetch, returns its original promise and response, restores fetch after the match, and reads only a bounded clone (8 KiB, 128 reads). It makes no replay request. Fresh 202, exact canonical message identity/sequence/text/scope/single admission, reload, CSRF and logout assertions remain. The retained failure log hashes to `a1f4fcb54b49c1e911104a6ed2b5d1c9e04c3e57cd29e46366c9298ab4dc004c`; missing CDP body retention remains an unproved cause. No hosted browser execution is claimed here.

The inert UI consumer preserves bounded descriptor metadata without reading, hashing, saving or promoting it. JavaScript unsafe integer lengths deliberately refuse even where the canonical unsigned wire type can represent them. No transport, storage roundtrip, browser, provider or release qualification follows from these pure tests.
