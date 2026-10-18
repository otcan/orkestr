# Targeted owned Stop browser acceptance

Prepared source, not executed browser evidence. The aa8 16-case receipt remains
pinned; it proved Stop unavailable and does not cover this successor.

Server prerequisite is reviewed ordinary owned Stop source
`abee5d1c4bc345a3461e1e3b536fea14ce6a95e4` or its reviewed successor. Coordinator
must register a matching source server/UI pair before the browser helper uses
this module. UI needs `web,execution-controls`, produced by the existing bundle
script with `UI_EXECUTION_CONTROLS=1` and `UI_SERVER_CANDIDATE=<exact registered
server commit>`. No client override of server capability exists. UI owns no
competing bundle build or lease. Independent native provider acceptance remains
separate from this fixed synthetic peer test.

The root helper owns managed lease acquisition, isolated context/server lifecycle,
artifact/served-byte verification and receipts. Run only these new Stop cases;
do not repeat history to resolve its unconfirmed first-run measurement. Preserve
both aa8 receipts and their unchanged assertions.

Use two fresh isolated server namespaces: `terminal` and `ack-only`. Configure the
ordinary server with the reviewed owned HTTP factory and fixed synthetic
`v2/tests/owned_execution_peer.py` at the matching server source. Reuse reviewed
factory/bootstrap from `v2/tests/owned_execution_http.py`; synthetic credentials
are local to the new namespace. Never use a real provider home or credential.
`stopFixture({workspace})` requires a canonical temporary path under
`orkestr-v2-browser-*` and `browser-stop.marker` containing exactly
`synthetic-browser-stop-v1\n`. Before server launch call `configure(mode)`; it
writes only the peer's existing `stop-mode` barrier. `releaseTerminal()` writes
its existing `release-stop` barrier. No SQL, Store state setter, product endpoint,
server auth weakening or inferred native authority is added. Fixture trace reads
return only kind/PID and verify a single native peer; liveness probing never
signals it. The runner owns shutdown and cleanup in every failure path.

After browser setup/login, call
`stopScenarios({page, conversation, fixture, report, signal, mode})`. It sends the
peer's exact first synthetic input from the actual composer, then preserves a
separate draft. A request-stage pause admits one ordinary followup over the real
cookie-authenticated message route, asserts the same run/new revision, and lets
the stale mounted Stop reach the server. Require real 409, no native interrupt,
explicit Review updated Stop, then a fresh request key/revision.

The real 200 public receipt is dropped at response stage after commit. Require
`requested_unknown` and no Cancelled before terminal evidence. In terminal mode,
release the peer's terminal barrier before retry to exercise the status/receipt
race. In ACK-only mode leave terminal evidence absent and wait for actual bounded
peer cleanup. Retry from the mounted Stop button must send exactly the original
request and recover the identical receipt, including after Stop capability goes
false. A duplicate actual HTTP request must return the same receipt. Final phase
must be Cancelled only in terminal mode, otherwise cancellation remains requested.
Require one turn, one interrupt, one native PID, the followup still present in the
durable snapshot with no second turn delivered, and the unrelated draft intact.

The peer's terminal barrier is finite (15 seconds in the reviewed source). Record
elapsed time, abort failed cases, and never extend product authority or fake the
clock to make a case pass. Receipts must include scenario/fixture/peer hashes,
registered server/UI identity, observed statuses, exact retry equality, phase,
trace counts, cleanup and any failures. Syntax or Rust state tests do not count
as mounted browser execution.
