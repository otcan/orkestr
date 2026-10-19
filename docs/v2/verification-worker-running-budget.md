# Independent Worker running-budget review

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
