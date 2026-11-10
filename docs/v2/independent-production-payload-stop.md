# Independent ordinary Progress and Stop probes

Implementation pin: `d690858337ac9266a860ffea5ec27c636edcb2ad` (includes payload
adapter `0bc3ffce`, schema8 `4c592ca3` and Stop revision guard `d03d2d77`).
These are independently authored ordinary Store probes, not fixture acceptance.
No provider process, inference or live interruption is exercised.

Export that exact commit to a private source directory. Copy
`v2/acceptance/production_payload_stop.rs` to
`crates/store-sqlite/tests/independent_production_payload_stop.rs` and copy its
`production_payload_stop/` directory alongside it. No manifest or lock edits are
needed. Use the required host Cargo wrapper with a dedicated target and absolute
isolated home. From the exported `v2/` run:

```text
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_production_payload_stop
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_production_payload_stop -- -D warnings
v2-cargo fmt -p orkestr-v2-store-sqlite -- --check
```

Independent execution: **3 parents passed, zero failed, one ignored owned-child
entry invoked by its parent**, final strengthened run 0.46 seconds. Strict
selected clippy and formatting passed. Harness binary SHA256:
`f8c716c88f18cd218fed998619a498e1aa82a23afb96bf260886e92269601ece`.
The earlier default two-test run passed in 0.41 seconds; it did not include
process tests. Repository CI does not automatically register these exported
acceptance tests; a green repository workflow is not evidence of their execution.

Coverage:

- Independent connections race identical Progress: one original receipt and one
  duplicate; schema8 replay contains a typed reference, never raw text. Foreign
  owner read/removal refuses with complete ledger equality. Removal changes only
  the nullable payload text. Identical retry retains the original event/sequence,
  changed text conflicts, and revoked authentication refuses historical replay.
- Stop stale revision, foreign owner/conversation and unbound Store refuse with
  complete ledger equality. Concurrent identical Stop requests return the same
  RequestedUnknown receipt. After canonical Stopped commits, original Stop replay
  returns its original revision/outcome without changing any terminal rows; a
  changed revision conflicts. No interruption success is inferred from Stop.
- Actual owned-child SIGKILL at public ObservationBeforeCommit and
  ObservationAfterCommit: two kill windows and two genuinely fresh executables.
  Precommit has exact zero partial rows. Postcommit has exactly one linked
  schema8 event, pending outbox, Progress observation, payload text/reference,
  conversation sequence increment and execution revision increment. Existing
  rows and all other execution tables remain byte-for-value equal. Fresh exec
  reads the same durable snapshot before and after Store::open; a live exact
  predecessor takeover is Busy and changes no rows.

The readonly oracle uses query_only and one transaction, all columns across 15
execution tables including production_payloads, cancellation/control tables and
issued lease history. It excludes authentication rows. Fresh UUIDs/timestamps and
semantic digest are structurally checked but carried from the observed row, not
independently regenerated; the digest is checked as 64 hexadecimal characters. No
verifier/text rows are printed. Child environment is cleared, child handles are
owned, waits are bounded, and Drop kills/reaps only the owned process.

Pending: real-expiry/new-context Progress historical retry and tombstone replay,
HTTP payload authentication/CSRF composition, populated-prefix migration rehearsal,
mounted browser rendering, provider interruption and production activation. The
existing independently tested predecessor-expiry matrix and cancellation process
windows retain their separate implementation pins; they do not supply these
missing payload cases.
