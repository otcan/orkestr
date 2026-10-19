# CLOSED-idle cold replacement oracle

Status: preparation only; native execution unexecuted. This is a separate
positive from the ACTIVE-loss refusal in `store_cold_process.rs`.

## Source boundaries

Core `1f0217a0c` publishes browser-only initial bootstrap. Its parent
`cda5019dc10db7b2001b9da066ab5ddc43fea849` contains the typed closure sequence
in `production_runtime/execution_window/terminal_tests.rs`:
`expired_proposal_acceptance_closes_only_with_terminal_provenance_then_reattaches`.
The new fixture must use its typed methods, without its SQL clock adjustment.
No elapsed-time boundary is required to prove a genuinely closed idle state.

Server `auth::setup` and `browser::login` are the ordinary password-authentication
boundary. `auth::verify_credentials` performs Argon2 verification;
`browser::credential` retains the browser credential representation. Direct
`Store::save_session` is not a substitute for this login acceptance case.
The existing Store-only cold oracle remains separately labeled fixture auth.

## Seed child

1. Use a fresh synthetic state directory, ordinary setup/password login and
   browser-only `bootstrap_execution_window_authenticated`. No machine token
   configuration or inherited session is supplied.
2. Admit a fresh durable input and first window, record modeled manager ACK,
   issue/bind the private window credential, confirm the exact native metadata
   prerequisites, then activate last. No provider process is started.
3. Claim the admitted input, admit its run, reserve/consume dispatch, append
   typed Started and CompletedProposal observations. These are modeled Store
   provider observations, not actual inference or native reap evidence.
4. Begin window retirement. Accept the exact completion using the current
   browser and expected execution revision. Call the trusted typed
   `retire_terminal_supervisor`, then `retire_execution_window` with the same
   run/window/generation/boot. Assert CLOSED, canonical terminal and immutable
   retirement provenance; assert no unresolved descendants or other supervisor.
   The trusted teardown invocation models the Runtime original-reap boundary;
   it cannot qualify actual manager/native retirement.
5. Revoke the seed browser session through ordinary logout. Write only public
   coordinates and before-state hashes to the handoff file: conversation,
   window/generation, terminal run/event identity, seed PID. Never serialize a
   cookie, private credential, Store, issuer or reap object. Exit and join.

## Replacement child

1. Start a different executable process after seed exit, with cleared environment
   and no inherited handles or seed output as input. Open state afresh.
2. Authenticate the synthetic owner through ordinary password/browser login,
   obtaining a newly issued cookie. Assert the seed session no longer works.
3. Use the forthcoming current-browser retired-context port. It must derive
   scope from authenticated owner and persisted exact terminal/retirement joins;
   no client-supplied supervisor identity or old machine token is authority.
4. Admit a genuinely new durable message/event/client key, then a new window
   with exact closed predecessor and expected generation. Obtain private
   authority using the published retired-context API, ACK/bind/metadata/activate
   in the specified order. Assert new generation and fresh window; predecessor
   deadline/budget/provenance and old input/run remain unchanged.
5. Independently retain the ACTIVE-loss case: fresh input after replacement
   cannot issue/admit a successor to lost ACTIVE lineage; reconciliation is
   durable and refused operations cause no writes. CLOSED success must not
   weaken that negative.

## Finite pre-execution closure

Before compilation seal the exact Core/server composition, added fixture files,
temporary registrations, manifests/lock, wrapper/toolchain, dependency closure,
environment allowlist and build argv. Before execution seal the produced binary
hash and exact parent/child filters, fresh directory absence, expected selected
test counts and per-child deadline. Verification reviews source and seal first.
Retain raw child output proving one selected test in each child, distinct PIDs,
joined exits and before/after inventories. Exit zero alone is insufficient.
No broad tests or release pair build is included.

## Exact pending seams

- Core: committed cold retired-context reconstruction/private issuance API;
  current bound-retired-Store issuance cannot survive loss of all Store handles.
- Server composition: a test-only leaf adapter invoking ordinary `auth::setup`,
  `browser::login` and logout with canonical Host/Origin/CSRF policy, while the
  typed Core producer remains available to the independent oracle. No public
  credential DTO, auth bypass or guessed reconstruction symbol is proposed.

Until those seams are published, this plan grants no CLOSED restart acceptance.

## Published-port independent successor

`v2/apps/server/src/window_runtime/closed_idle_process_tests.rs` and its two
purpose-specific child modules target Runtime `8a26e8d9b` plus exact Core
`16e8d9772718bf3fa96e7c0b6072eca731d9dc29` recovery delta. Runtime alone registers
`#[cfg(test)] mod closed_idle_process_tests;`. No production registration is
included. No dependencies/manifests/lock/schema edits are required.

The CLOSED seed completes early through typed proposal/acceptance/retirement;
it uses no SQL clock or authority writes. Both replacement cases use newly
verified passwords and newly issued browser cookies after seed logout. The
ACTIVE case admits a fresh durable input before testing exact successor refusal;
it compares the public window projection before/after refused operations.
That comparison does not claim full-table no-write coverage: the separate Store
fresh-input oracle supplies the bounded full-table observation when qualified.

Authentication calls the actual setup/login/logout handlers after the ordinary
browser guard, including wrong-Origin and missing-CSRF negatives. No HTTP
listener/router is mounted, so this is handler/Store process evidence, not mounted
HTTP acceptance. All manager ACK/native metadata/provider events/reap remain
modeled trusted Store inputs, never actual Runtime cleanup or provider proof.
Parent joins each child before creating the replacement; each child prints only
phase and PID. Coordinates contain conversation/input identifiers and seed PID;
no credential or opaque object crosses process boundaries.

Expected exact filters under the Runtime registration:

- `window_runtime::closed_idle_process_tests::closed_idle_fresh_login_after_exec`
- `window_runtime::closed_idle_process_tests::active_loss_fresh_login_after_exec_refuses`
- child `window_runtime::closed_idle_process_tests::child` (one selected test per exec).

Source formatting/diff checks only have run. Native compile, lint and execution
remain unexecuted until the exact disposable composition/preseal is reviewed and
focused server build admission is confirmed.
