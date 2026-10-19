# Beta1 finite execution window — initial ABI

Base: `87b303ed73098d8b7ea7bd8eea384b268b7a40c8`. Migration 0042 is reserved for this slice. This checkpoint freezes browser DTOs; Store methods below are implementation targets, not callable ports until the Store successor is published. No builds or starts accompany this checkpoint.

The original browser credential calls `execution_window_status_authenticated(credential, &ConversationId) -> Result<Option<ExecutionWindowStatus>>` and `admit_execution_window_authenticated(credential, &ConversationId, &ExecutionWindowRequest) -> Result<ExecutionWindowAdmission>`. GET/POST `/api/v2/conversations/{id}/window` are Runtime-owned. `/api/v2/beta` is configured capability discovery, never provisioning authority. Only the configured Codex Deep conversation is supported; steering availability must reflect the actual configured adapter.

Admission binds exact durable owner input message/event/client request key. A new window requires expected latest generation and exact closed predecessor (none on first admission). `window_id: Some` explicitly admits another input to the same active window with no generation/deadline/budget change. Request-key replay returns the immutable original receipt; clients reread status. Changed semantics conflict. Original current auth is checked before replay. Unadmitted/held inputs remain durable; claim selection and admission must enforce the exact window association inside the transaction, never server FIFO filtering.

The single manager ledger owns 900 seconds, 32 attempts and 64 MiB TOTAL. Cleanup reserves 30 seconds, four attempts and 1 MiB INSIDE those totals. Work ends at 870 seconds. Core does not implement a second refundable budget ledger. Opening commits before manager IPC. Only an authenticated manager ACK for exact boot/window/generation/absolute expiry permits private credential issuance. No inference before Core activation.

Private implementation ABI:

```rust
issue_execution_window_credential(old_machine, window, generation, boot,
    absolute_expiry_ms, manager_ack_sha256) -> ExecutionWindowCredential
bind_execution_window(old_machine, &ExecutionWindowCredential) -> Store
activate_execution_window(new_machine, window, generation, boot)
    -> ExecutionWindowStatus
begin_execution_window_retirement(new_machine, window, generation, boot)
    -> ExecutionWindowStatus
mark_execution_window_uncertain(new_machine, window, generation, boot)
    -> ExecutionWindowStatus
retire_execution_window(new_machine, window, generation, boot, &RunId)
    -> (Store, ExecutionWindowRetirement)
```

Private credentials are non-Clone/non-Deserialize, returned once, never written to the configured token file or serialized over HTTP. Lost issuance/retirement reply requires reconciliation, never reissue. Existing typed terminal reattachment must bind the new credential/window incarnation in its own transaction BEFORE metadata reservation. Opening permits metadata setup only; activation preserves that exact metadata grant. Generic supervisor bootstrap with window credentials must refuse.

At 870 seconds Runtime begins retirement, fencing inference, steering and tool-result suffixes. Exact issued cancellation cleanup may continue only until the original 900-second deadline. No network wait or ACK wait runs inside a SQLite writer callback. Written bytes remain unknown on interruption; there is no recall promise.

AwaitingAcceptance at 900 remains AwaitingAcceptance. Browser owner acceptance uses its separate current authenticated browser credential and remains available; it does not reopen the window. A still-current private credential may record/read truthful terminal evidence and invoke existing terminal retirement after owner acceptance and retained original Runtime ReapedBroker proof. It grants NO post-900 provider bytes, even cleanup. If machine auth/supervisor lineage is lost, reconciliation is required. No credential renewal, fabricated terminal state, empty ChildSet or successful task return substitutes for original reap evidence.

Closing requires exact canonical terminal evidence, matching immutable terminal-retirement provenance, no unresolved descendants/effects and current original machine auth. Old authority is retired before replacement issuance. Proposal/ACK-only/unknown cannot close or unlock another window. ExecutionWindowRetirement retains the SAME original authenticated credential as a private retirement handoff; closing mints no successor credential or budget. Next browser admission and next manager ACK remain mandatory before separate one-shot credential issuance.

## Cross-contract lock: deadline and exact integers

Manager retirement after the hard deadline is metadata-only: it may close the exact boot/window/generation only after canonical accepted-or-Stopped terminal retirement and retained original parent/descendant reap evidence. It cannot reserve an attempt, forward a byte, extend a deadline, or issue execution authority. If the manager cannot support this metadata-only operation, keep reconciliation_required and refuse a next window; never reinterpret retirement as a cleanup allowance. Core may close only after its existing terminal-retirement provenance has committed. AwaitingAcceptance alone is insufficient. Browser acceptance after expiry is independent owner authority, not renewed machine/provider authority.

Issued beta window generations are positive integers strictly below 2^53 (MAX_SAFE=9007199254740991 included). Request expected_generation additionally permits zero for initial admission. Creating a successor at MAX_SAFE refuses rather than overflowing. Request expected_generation and every manager IPC integer must be validated before IPC; reject out-of-range values, never convert through floating point, truncate, or wrap. Existing unrelated Core generation types remain unchanged.

First opening uses an existing trusted idle Codex Deep supervisor and its existing exact role binding. After manager ACK, issue once, then bind the returned opaque credential into that Store before metadata setup. Generic supervisor bootstrap with that credential refuses. Terminal replacement uses the existing unbound terminal candidate/reattach ports with the newly issued credential; Core rebinds the exact window incarnation in the same transaction before metadata reservation. The server bypasses static-token loading and never rewrites the token file.

## Always-on idle owner issuance

`bound_retired_store.issue_idle_execution_window_credential_authenticated(current_browser, window, generation, boot, expires_at_ms, manager_ack_sha256) -> Result<ExecutionWindowCredential>` returns the same private nonserializable one-shot type. It authenticates the original current browser credential inside BEGIN IMMEDIATE, requires the same owner, exact current retired context/incarnation and immutable retirement provenance, no unresolved runs/descendants, and no previously issued nonclosed window or nonretired supervisor for this conversation. The old machine credential may be expired only in this already-proven idle case. Unresolved or unretired expiry refuses without issuance; no replacement token repairs old authority. This port follows exact new browser admission and manager ACK; it is not an HTTP token response.

### Fresh-owner private bootstrap

`Store::bootstrap_execution_window_authenticated(browser_credential, conversation,
ProductionSupervisorConfig) -> Result<ExecutionWindowBootstrap>` is a trusted
in-process composition port, called on the unbound Store **before the first
window admission**. The config must select Codex and `ProductionTakeover::First`.
Inside one immediate transaction it authenticates the current browser owner,
checks the conversation scope, and refuses any existing owner supervisor, window,
run, or binding history. It creates a separate twelve-hour private credential,
a current idle supervisor and ordinary unconfigured Starting role bindings.
It creates no native readiness, run, or dispatch.

The non-Clone/non-Debug/non-serializable result exposes `store() -> &Store`,
`credential() -> &str`, and `binding() -> &Binding`. Its credential is accepted
only for the dedicated window issuance/binding handoff, not generic supervisor
bootstrap; the retained context refuses input claims, metadata and effect fences
until it has been replaced by the bound window credential. The caller then
admits the browser input/window, obtains the authenticated manager ACK, issues
and binds the window credential, performs metadata setup, and activates last.
No secret is returned through HTTP, written to config, or reconstructed after
process loss. A lost bootstrap reply/history refuses reissuance and requires
reconciliation. This is separate from the safe-retired idle-owner issuance port.

### Cold restart after CLOSED graceful retirement

`Store::recover_retired_execution_window_authenticated(browser, conversation,
ProductionSupervisorConfig) -> RetiredExecutionWindowContext` is a private,
read-only current-browser-authenticated port on an **unbound** Store. Config must
be the trusted configured Codex/First namespace and supervisor key. The returned
non-Clone/non-Debug/non-Serde handle exposes `store()`, `prior_run_id()`,
`binding()` and `predecessor_incarnation()` only. It contains no recovered or
newly generated credential. Its bound retired Store has no authenticatable
machine credential; ordinary execution/metadata paths remain unavailable.

Call before successor admission. Discovery joins the exact CLOSED, bound window
and terminal run to current supervisor incarnation/generation, terminal event,
graceful retirement, Ready Deep binding, native session and readiness provenance.
Every owner window must be CLOSED, every supervisor gracefully retired and every
run terminal; descendant/task/tool/result/control guards must be clear. A pending
resume reservation refuses. Expiry, ACTIVE, Opening, reconciliation and a missing
retirement marker never qualify. No old secret is read, persisted or recovered.

Then admit a fresh owner input/window, obtain exact manager ACK, call the existing
`handle.store().issue_idle_execution_window_credential_authenticated(...)`, and
reattach with that newly issued credential plus exact prior run/incarnation.
Workspace configurations still require the existing typed installation-bearing
reattachment. Issuance and reattachment repeat their authoritative checks in their
own immediate transactions. Lost issuance is not reissued: Opening history blocks
cold rediscovery. This does not resume an old input or create a time/attempt budget
without separate admission and manager ACK.

The Store process oracle executes two sequential, joined OS child processes with
cleared environments. The seed commits accepted terminal retirement and CLOSED;
the replacement receives only database coordinates and browser login, recovers
this handle, admits fresh input, issues once and reattaches/activates. A separate
ACTIVE-loss pair refuses recovery/bootstrap and only records reconciliation.
Native cleanup in these tests is synthetic; they prove durable Core composition,
not Runtime/manager/native reap behavior.
