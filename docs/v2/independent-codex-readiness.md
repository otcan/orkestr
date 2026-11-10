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

## Correction independently verified

Exact correction `7d1fa052d2b59d1f76078696724364e5ba2c18ca` was re-queried as
PR76 head and reviewed. Pending thread state retains the requested normalized
absolute workspace. Before publishing the locator, both returned workspace fields
must equal it and ephemeral must explicitly be false. Real filesystem
canonicalization/symlink containment remains trusted Executor responsibility;
this module's normalization is lexical, not an OS containment proof.

The unchanged two independent regressions from `17543337` passed against an exact
isolated archive of `7d1fa052`. Six supplied protocol tests also passed in that run;
those are independently executed author tests, not independently authored cases.
The independent test was then strengthened with the otherwise-valid thread.cwd,
a successful persistent same-workspace control, and separate missing/type/value
mutations of each of the three fields: **4 independent tests passed**, zero
failures/ignored. This avoids a different missing field masking a refusal check.
All tests used the assigned wrapper, verification target/home, locked/offline,
without changing implementation/manifests/lock or launching a provider.

The original P2 persistence/workspace finding is closed at this exact correction.
No subscription entitlement, actual native readiness, durable production dispatch,
provider execution, lease/cancel/recovery or containment acceptance transfers from
these metadata tests. The historical 0/2 failure above remains accurate at `831198ae`.

Strict selected independent-test clippy with `-D warnings` passed; pinned wrapper
formatting and repository diff checks passed. No broader package clippy result
is claimed from this selected target.
