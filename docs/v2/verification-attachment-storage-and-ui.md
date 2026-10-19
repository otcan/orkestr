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

## Additional independent oracle receipt review

Reviewed Migration oracle `7583bdb226321bfb6e5b891e3656b304c7194fcf` without repeating its Store execution. Its retained receipt, raw test/lint logs, binary, committed Store oracle source and seven canonical Core source hashes match the declared digests. Receipt SHA-256: `acb8c4accb6b050e39a383d3eca0b1d0da390fea25d5ef99316c6a332fea91d7`. Both retained test invocations report 2/2 passing; execution remains attributed to the oracle author.

No bounded source/receipt blocker found. The oracle uses actual public authenticated Store operations across two fresh stores, export/import, reopen, exact binary/empty/duplicate-content vectors, persisted source provenance, fresh unbound target references, removal and historical replay, revoked-session refusal, malformed imports, changed request conflict and cross-scope download refusal. Pure-validator integration remains explicitly unexecuted in this receipt.

Its no-admission checks compare counts in four selected tables, not full-row equality or all native authority tables. Malformed-import checks establish target manifest absence, not a complete database rollback snapshot. Reopen is a new pool in the same process, not a fresh executable or crash test. These are limits of this oracle's evidence; HTTP, live import and crash acceptance are not claimed.

## Canonical attachment HTTP source and supplied execution review

Reviewed dependency `b95415ee4412b306c76b37f2a207a85f3a9df1e4`, leaf `146bcb4aa6ba17a53b172126d927678a33a98ab5`, and final canonical mount `1198204e05246dc946ba22a555b42a0dccd35a10`. No bounded source blocker found. The final mount nests the leaf under `/api/v2` inside the existing shared browser guard. Browser mutations inherit exact Origin/Host and CSRF checks; cookie plus Authorization and duplicate Bearer credentials refuse. Handlers preserve the original credential for Core transaction-time authentication, rather than treating the preliminary owner lookup as authority.

The leaf uses strict typed requests, scoped Store operations and a bounded attachment-specific JSON limit. Downloads revalidate exact length and SHA-256, encode filenames into an attachment disposition, and set no-store/nosniff headers. No filesystem path, redirect, URL fetch, native grant or new application state is introduced.

Reviewed retained coordinator logs: canonical-router filter reports 8 passing entries (including a child helper entry), and selected strict lint reports success. The canonical test includes a 48 KiB raw fixture exceeding the ordinary 40 KiB limit, demonstrating the attachment override through the actual shared router. Log SHA-256 values are `c6b6716e873a67c36f0656297fa0bd5d64019eb833c28de28d02995456393bb8` (tests) and `ee0307837c0c5f065f670cb5b54114c240ecc46f12f220aaad267cefaff4f507` (lint). Execution remains attributed to the coordinator; no duplicate HTTP run was performed in this review. Logs identify a mutable coordinator worktree, not an independently sealed source/binary build receipt.

HTTP cases use Bearer authentication; browser cookie/CSRF mutation coverage is source-reviewed, not demonstrated by those HTTP cases. The owned-child test kills after a successful import response and reopens in the parent: it is not an in-transaction crash or fresh-executable retry oracle. No browser, provider, live import or release qualification follows.
