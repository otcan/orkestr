# Independent Worker running-budget review

Historical schema35-only review, superseded by the schema36 gate below.
Do not activate host-only schema35 continuation.

Reviewed exact Core `3c3932f9199eb7a04c56f36915016133455702dd` (schema 35).
No bounded source blocker found in budget capture, renewal, or renewed tool-parent
issuance. This gate covers ordinary Store behavior, not transport registration or
provider execution.

The trusted-host issuer requires a genuine consumed owner-task Worker under the
current context, machine authentication and live canonical Deep parent. Schema 35
starts empty. Its unique task/run ledger anchors the immutable 1..3,600,000 ms
budget to original task creation; a changed capture conflicts. Generic renewal
retains its existing delegation bound.

Renewal authenticates the exact current admission inside BEGIN IMMEDIATE and
requires Running/DeliveryUnknown. Its deadline is at most transaction clock plus
30 seconds, clipped to budget, current parent and supervisor. The delegation,
issued lease history and run generation advance atomically. Stop, parent terminal,
expired authority and revocation refuse; generation CAS prevents two winners.
Historical issued envelopes do not become current I/O authority.

The renewed offline-tool issuer requires successful durable renewal, the exact
current Worker envelope and current credential. Existing tool/result grants are
not extended. Runtime's quiescent transfer remains a trusted composition duty;
this Store API does not prove that transfer or native process identity.

## Independent execution

Used an exact git archive, isolated home and the required Cargo wrapper with
`--offline --locked`, `fixture-test-controls`, and library filters:

- `running_renewal`: 9 passed, zero failed/ignored (four supplied budget cases and
  five existing renewal cases). These are independently executed supplied tests,
  not independently authored acceptance cases.
- `preflight::tests`: 9 passed, zero failed/ignored, including populated prefix
  upgrade, row/FK preservation and byte-preserving refusal cases.

The first renewal invocation omitted the harness-required `ORKESTR_V2_HOME`; all
nine cases stopped at that environment assertion before Store setup. Its raw log
is preserved separately from the corrected passing run. No source was changed to
obtain the pass. Raw logs remain private.

No independent long-running native, HTTP, tool/result delivery, crash, or runtime
quiescent-transfer qualification is claimed. No production activation or server
implementation was performed.

## Superseding owner-consent gate

Reviewed exact Core `f6a0885572c4801b81f9e6b56eb375b951f9d27d`, schema 36.
No bounded source blocker found in the correction. This replaces the schema35-only
qualification; it does not authorize that earlier host-only mode.

Absent `execution_budget_ms` is omitted by serialization and retains the exact
v1 request digest and delegation lifetime. Explicit values must be at least the
initial lifetime and at most one hour, use a distinct digest, and persist with
the task. Current browser authentication still precedes replay; the same key
with changed budget conflicts. Input reconstruction verifies the persisted
optional value against the corresponding digest.

The effective absolute deadline is task creation plus min(owner budget, host
cap). Repeated host issuance cannot enlarge the recorded budget. Both issuance
and spending require the owner field. In particular, schema35 ledger rows are
preserved by migration but their absent owner field excludes them from the new
budget-spend query. Existing current-auth, live-parent, Stop, expiry and generation
CAS checks remain in the renewal transaction; old tool/result grants stay stale.
No expired run is revived.

Independent execution used a fresh exact archive and isolated home through the
required offline locked wrapper:

- Worker filter: 67 passed, zero failed/ignored. Includes supplied legacy digest,
  changed replay, owner-required issuance, both clamp directions, and prior
  auth/parent/Stop/tool refusal cases.
- Preflight: 9 passed, zero failed/ignored.
- Worker request contract: 1 passed, zero failed/ignored.

Also independently exercised the exact schema35 and schema36 SQL in a minimal
populated SQLite foreign-key fixture: old budget row unchanged, owner column NULL,
old row excluded by the new spend predicate, foreign-key check clean, and owner
budgets below initial lifetime or over one hour rejected. This is a small migration
oracle, not an authenticated Store renewal or full populated production upgrade.
Raw output is retained privately. Supplied test execution is separate from
independently authored acceptance. Transport transfer, HTTP owner input wiring,
long-running native execution and production activation remain unqualified here.
