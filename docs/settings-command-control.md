# Settings commands are control operations

WhatsApp and authenticated WebUI composer commands do not create conversation
messages or model turns. Existing messages are preserved. A compatibility drain
completes already-queued commands without an assistant history entry; WhatsApp
records without a verified effective sender role fail closed.

## Commands

- `/model` or `/model status`: current model, effort, fast state and live catalog.
- `/model <id> [effort]` or `/model default`: validated change.
- `/effort` or `/effort status`: current and supported efforts.
- `/effort <level>`: validated change for the current model.
- `/fast` or `/fast status`: status only, never an implicit toggle.
- `/fast enable|enabled|on`, `/fast disable|disabled|off`, `/fast toggle`.

Commands and aliases are case-insensitive; additional arguments are rejected.
Settings commands cannot carry attachments. Debug footers advertise the three
shortcuts only on supported, writable runtimes. The WebUI shows typed-command
results in a dismissible, wrapping status panel, not a synthetic conversation.
The existing model-settings GET/POST endpoints remain available.

## Authorization and durability

The WhatsApp adapter runs after source deduplication, route resolution and
inbound participant classification, before message construction/enqueue. Only
the classified owner/admin role may read the catalog or change settings.
Contained and unsupported/terminal runtimes refuse commands without RPCs or
terminal fallback. WebUI callers are checked against the current thread owner.

The operation key hashes surface, owner, account, chat, thread and canonical
source-event identity. Event aliases share a key; different events do not.
The WebUI uses its client message ID scoped to the authenticated owner/thread.
The private `settings-control-operations` directory under the runtime home
contains one redacted audit/tombstone per operation. It does not store command
bodies, participant IDs or provider error text. Results can contain catalog
model names, not credentials or private endpoints.

The operation lock and journal must live on the same durable shared runtime
home as the existing model-settings locks for every process operating that
runtime. A database-backed outbox alone does not provide cross-host journal
coordination. Do not run independently mounted writers for the same runtime.
Keep the operation journal with runtime backups. Do not expire tombstones while
source events might be replayed, even if the connector outbox is pruned.

An intent is persisted as `control_reply` before any provider action. The
operation's started record is persisted before catalog/settings RPCs; completed
results are reused across duplicates and restarts. An interrupted operation
without a recorded result is reported unconfirmed, never reissued. The existing
correlated settings acknowledgement and uncertainty guard remain authoritative.

The reply worker uses the regular WhatsApp sender, without final projection.
It writes a permanent send-attempt fence before dispatch. A lost receipt becomes
`delivery_unknown` (represented by the outbox's existing `delivery_uncertain`
state), and is not automatically replayed. This intentionally favors avoiding
duplicates over guaranteed delivery after a crash. Operator outbox replay does
not bypass the settings journal fence. Inspect provider delivery evidence before
issuing a *new* command; never delete the tombstone to force a retry.

## Signals and rollback

Bounded metrics (no owner/chat/model identifiers in labels):

- `orkestr_settings_commands_total{surface,command,outcome}`
- `orkestr_settings_command_deduplicated_total{surface,command}`
- `orkestr_settings_control_replies_total{outcome}`
- `orkestr_settings_history_leak_total{surface}`

Watcher alerts report `settings_operation_unconfirmed` for interrupted or
uncertain operations, `settings_reply_delivery_unknown` for uncertain sends,
and `settings_history_leak` if a settings input reaches canonical storage.
The existing settings RPC/catalog deadlines remain five seconds each.
Investigate these alerts rather than resending or clearing uncertainty blindly.
Regression tests assert zero turn/start, turn/steer and history entries at new
ingress, plus recovery and concurrent event behavior using synthetic fixtures.

For a command-only rollback set `ORKESTR_SETTINGS_COMMANDS_ENABLED=0`.
Interception remains enabled and refuses commands, directing users to WebUI
model settings. Do not restore the old history-polluting fallback. This flag
does not disable the existing WebUI model-settings endpoints.
