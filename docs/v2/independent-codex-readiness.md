# Independent native readiness review

Exact Runtime checkpoint: `831198ae8809c00f4e825dae3ca87bec16502d70`.
The new module is metadata protocol state only: it has no process launcher or
turn submission, and does not confer durable dispatch authority. Matching request
IDs, subscription account selection, read-only sandbox and no-network response
checks are present. Native/account state is not exposed through Debug. Author
five protocol passes remain separate from independent execution below.

## P2: thread reply does not confirm persistence or requested workspace

`CodexRpc::create_session` requests `ephemeral:false` and the trusted absolute
workspace. The Thread response branch checks only thread ID, approval policy and
sandbox; it then sets `native_session` without checking `thread.ephemeral` or
returned `cwd`. A reply explicitly reporting an ephemeral thread, or a different
workspace, is accepted as native readiness. This contradicts the persistent,
workspace-bound readiness requirement before ordinary Store confirmation.

`v2/acceptance/production_codex_readiness.rs` independently reproduces both cases.
It is installed as an integration test in an isolated exact-head archive; no
implementation, lock or manifest change is needed:

```sh
v2-cargo test --offline --locked -p orkestr-runtime --test independent_codex_readiness
```

Result: **0 passed, 2 failed, exit 101**, both failures showing actual `Ok(None)`
where fail-closed `Err(Protocol)` is required. The wrapper compiled the exact
module successfully. No provider process, inference, credential/profile read or
native session was used. The intended negative assertions remain failing evidence,
not passing acceptance. Formatting used the pinned wrapper on the isolated test
copy; only the independent test was copied back.

Installed CLI `0.163.0` schema generation used a fresh empty Codex home.
`ThreadStartResponse` requires returned `cwd`; its Thread definition describes
`ephemeral` as whether the thread is not materialized on disk. Its readOnly
networkAccess defaults false, so accepting an omitted networkAccess is consistent
with this installed schema. Current official context is available in
[Codex App Server documentation](https://developers.openai.com/codex/app-server);
the installed version's generated schema is the authority for these concrete
field checks. Generating schemas is not a provider readiness or entitlement test.

Before adapter integration, validate returned persistence and the expected
canonical workspace (reject mismatches or define an explicitly reviewed canonical
path equivalence), retain that expectation across the outstanding request, and
leave native readiness unconfirmed on refusal. Add missing/malformed field cases
and a valid persistent same-workspace control. Ordinary execution/lease/cancel
and real-provider gates remain pending. There is no production activation here.
