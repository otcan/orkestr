# Removable production progress

Schema 8 reuses `ConversationEvent::ProviderObserved` and SSE name
`provider_observed`, with `observation.kind=progress_ref` and a nonnil typed
`payload_id`. Schema 5 remains byte-compatible and cannot contain ProgressRef;
schema 8 cannot contain another observation kind. Fixture:
`v2/fixtures/provider-observed-progress.json`.

The existing application `append_provider_event` accepts bounded raw Progress
(up to 8192 UTF-8 bytes), only after Started, and stores text separately from
canonical replay metadata. No replacement runtime port is required. The planned
ordinary Store methods `provider_payload(owner, conversation, payload_id)` and
`remove_provider_payload(owner, conversation, payload_id)` authenticate the owner
and scope. HTTP composition must supply its authenticated owner and protect
removal with browser CSRF/Origin checks. Text is untrusted display content.

Removal tombstones text without deleting the event, deduplication digest or
receipt. Identical historical committed retries return the original receipt,
including after expiry, cancellation or removal, and never restore text. Changed
content conflicts. New evidence still requires current execution authority.
Completion remains AwaitingAcceptance, not success or permission for reuse.

## Adapter

Migration 0014 preserves canonical event IDs, bytes and foreign keys while
adding schema 8 and `production_payloads`. Its row contains payload ID, event,
owner, conversation, run and nullable text. No native identity or raw text goes
into the journal. Existing observation checkpoints cover the payload write in
the same transaction (before COMMIT, or after COMMIT before receipt delivery).

`Store::provider_payload` returns a tombstoned record with `text: None` after
`Store::remove_provider_payload`; unknown/wrong-scope IDs return NotFound.
Unbound Store is suitable for authenticated HTTP reads/removal; a bound handle
also checks its live authentication token. Removal is logical application
removal, not forensic erasure of WAL, filesystem snapshots or backups. A caller
must not log payload text; its Debug formatter is redacted.

Running + Progress remains Running. Starting + Progress conflicts rather than
inventing Started. Existing 8192-byte bound applies to each UTF-8 chunk. A valid
next completion proposes acceptance normally, so progress no longer permanently
blocks Runtime's ordered retained-event pump. Status includes the latest stable
payload reference/time, never raw text. Removal does not change that reference.

Author tests cover concurrent receipt winners, whole-row rollback, byte limits,
forged envelopes, owner isolation, removal/reopen and historical retry after
takeover. Actual Progress-specific SIGKILL/reply-loss acceptance remains for
independent verification; pool reopen is not counted as process recovery.
