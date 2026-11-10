# Independent Worker metadata checks

Pin: Core `5698537783f4c9b4cfd75465aae74f1c543fe5ea`.

`v2/acceptance/worker_metadata.rs` contains two independently authored tests.
In an owned exact-source export, register it as a test-only module under
`production_runtime/worker` (the tests use existing private setup/oracle helpers;
this is not a public setup or recovery API). No implementation changes are needed.

Run through the required host wrapper with isolated target/home:

```text
test --offline --locked -p orkestr-v2-store-sqlite --features fixture-test-controls independent_
```

The two tests passed in a disposable export. Stop, completion proposal and session
revocation after metadata issuance each refuse the setup callback and readiness
confirmation with unchanged ledger snapshots. Wrong owner and conversation refuse
exact-run status without writes. These are sequential boundary interleavings, not
simultaneous race or process-crash acceptance. The oracle uses the existing Worker
ledger snapshot helper; it is not a filesystem byte-preservation oracle.

Separately, the exact-source supplied Worker filter passed 14 tests: eight Worker
cases and six existing tool cases. This is an independent rerun of authored Core
tests, not 14 independently authored cases. Worker SIGKILL/new-exec, HTTP/provider
composition and activation remain pending. No CI result is claimed here.
