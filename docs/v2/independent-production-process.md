# Independent ordinary-authority process checkpoint probes

Implementation pin: `d2a1720bad57df5030aaa962c64e8960feff67e5`.
Independent test source: `v2/acceptance/production_authority.rs` and its
`production_authority/process.rs` module; metadata module remains required.
Copy these into store-sqlite's integration-test directory preserving module paths.
Enable the existing `fixture-test-controls` feature. Despite that feature name,
these tests use ordinary Store authorization and ProductionCheckpoint only.

Executed through the required host wrapper, with a dedicated source-pin target:

```
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_production_authority
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls --test independent_production_authority -- -D warnings
v2-cargo fmt -p orkestr-v2-store-sqlite
```

Result: six parent tests passed, zero failed; one ignored child entry is invoked
by the process parent, not a pending acceptance case. The new parent executes
seven independently bootstrapped owned children and seven genuinely fresh probe
processes. It checks exact marker bytes, retained-child SIGKILL signal 9, full-row
read-only transaction equality before all four precommit windows, committed
changes at all three postcommit windows, run/inbox-ack count equality, and durable
`delivery_unknown` after consume commit. Snapshots cover the ten tables listed
in the authority helper; no auth credentials/verifiers are printed. No source
SQLite connection is opened before the immediate post-kill read-only snapshot.

Every fresh probe uses public authenticated exact-predecessor authorization,
proves live predecessor Busy, durably revokes the synthetic machine session, and
proves subsequent authorization Unauthorized. The ten-table ledger is unchanged
by these refusals/revocation. No context, candidate, reservation, or capability is
serialized or reconstructed. Public predecessor incarnation and owned case path
are the only child artifacts used for authorization setup; the token is synthetic.

Final executable SHA256:
`a4766f46412475e77b1cd731e40d12a4e030848df67130f3aa1531cc3a7effaa`.
Initial attempts exposed harness-only errors (non-Clone config and SQL state
spelling); neither is reported as passing. Final complete run took 0.91 seconds;
strict clippy and diff check passed. Independent review of these authored tests
and exact pushed-head CI remain pending.

This slice does not yet wait for natural supervisor expiry, perform successor
quarantine/reconciliation, or compare a historical receipt after lost reply in a
fresh process. Postcommit inequality alone is not an exact expected-row oracle.
Issued lease history, execution revisions and authentication rows are outside the
current ten-table snapshot. These are explicit next acceptance work, alongside
new ordinary observation checkpoints. No provider execution, production activation,
lifecycle completion, or general recovery acceptance is claimed.
