# Configured multi-conversation execution

The ordinary server can compose up to 16 explicitly configured conversations.
Each uses its selected supervisor, bound Store, controls, task scheduler and
private scratch directory. HTTP locators select only the exact authenticated
owner and conversation; an unknown or unconfigured conversation never borrows
another conversation's provider or controls.

`ORKESTR_V2_EXECUTION_SET` selects a canonical, unaliased, mode-0600 file owned
by the private data-home owner. It is mutually exclusive with the existing
`ORKESTR_V2_EXECUTION_CONFIG` single-conversation setting. Example paths are
placeholders:

```json
{
  "schema_version": 1,
  "mode": "isolated-acceptance-set-v1",
  "configurations": [
    "/private/acceptance/first-execution.json",
    "/private/acceptance/second-execution.json"
  ]
}
```

Every entry uses the existing private execution configuration and loopback
listener requirements. The complete selection is validated before requesting
supervisor authority. Duplicate conversations, duplicate namespace/supervisor
identities, empty or oversized sets and unknown fields are rejected. No provider
starts until all configurations and HTTP registrations succeed. A later
authorization failure stops startup; the supervisor grants are not a single
transaction and may require reconciliation before another attempt.

Set mode stores scratch state under `owned-executions/<conversation-id>`.
Single mode preserves its existing `owned-execution` layout. Switching modes
does not migrate or reactivate prior execution state. Shutdown signals every
configured slot before joining any slot, and waits for each owned cleanup.

`owned_execution_group` exercises two real ordinary server execution paths with
synthetic native peers. It verifies independent Stop, cross-scope refusal,
unknown and unconfigured conversation refusal, durable follow-up holds, joined
shutdown and invalid-manifest refusal. Existing single-conversation, Worker and
authentication checks remain required.

`owned_execution_group_recovery` checks accepted restart of both conversations,
fresh-input-only continuation, exact native/session lineage and inert receipt
replay. An ACK-only slot refuses the entire configured restart. An earlier
accepted slot may retain an issued setup reservation after that refusal, but no
reservation is confirmed and no provider starts; reconciliation remains required.

This is an explicit isolated acceptance composition. Creating a project through
HTTP does not configure a provider. Dynamic conversation registration, real
provider isolation and final release qualification remain separate work.
