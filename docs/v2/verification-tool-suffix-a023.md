# Independent synthetic tool-result suffix review

Reviewed Runtime `a02398a1cfb1a388a0667b7ae2685ecfca0558d3`: the two new offline-delivery test files and their private registration. No blocking source finding within this bounded scope.

The fixture uses public ordinary Store authority and a real SCM_RIGHTS handoff to an owned synthetic reader. It checks source identity in addition to matching identifiers, exact output bytes, and the owned-reader count reaching zero after child wait/reaping. Its tool execution callback is synthetic; it does not execute a sandboxed tool.

## Independent execution

The unchanged filter `containment::tests::offline_delivery` passed: **2 tests, 0 failures, 0 ignored**, covering four cases in 0.63 seconds:

- Exact source writes the complete synthetic result.
- Matching identifiers with different source write zero bytes.
- Credential revocation before writing withholds the first byte.
- Revocation after a seven-byte prefix permits no further suffix; the reader records exactly seven bytes.

The disposable composition exported exact Runtime a023, overlaid application/contracts/Store source and Store migrations from Core `75cee9838cb45f7274c615b02e9457e58cc2def5`, and overlaid the source matcher and its test file from `596c08ba8954f07cd518ca7b0119e2ce4a68ea90`. Runtime manifests and lock remained unchanged; no dependency resolution was performed. Extra unregistered files in the export were inert. The required wrapper ran `test --offline --locked -p orkestr-runtime --lib containment::tests::offline_delivery -- --nocapture` with separate home and target directories.

Private source and log are retained under `/var/tmp/orkestr-verification-tool-suffix-a023`; no product binary or provider was launched. The first current-thread fixture attempt reported by the author was not independently reproduced here. This run used the committed multithread fixture.

## Limits and attribution

These are supplied tests independently reviewed and rerun, not independently authored acceptance. The fixture credits the earlier df9c source-guard work. No full broker, sandbox, HTTP, Core finish, native acknowledgement, or Worker completion claim follows. No original independent 8ea cancellation-oracle rerun is claimed: Runtime confirmed that no preserved original oracle path was available. The separately recorded supplied red-8ea/green-e573 cancellation evidence remains distinct.
