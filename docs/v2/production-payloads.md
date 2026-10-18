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
