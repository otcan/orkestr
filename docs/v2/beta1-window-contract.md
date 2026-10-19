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

Closing requires exact canonical terminal evidence, matching immutable terminal-retirement provenance, no unresolved descendants/effects and current original machine auth. Old authority is retired before replacement issuance. Proposal/ACK-only/unknown cannot close or unlock another window. A successor credential is a private bootstrap handoff only, never fresh execution budget; next browser admission and next manager ACK remain mandatory.
