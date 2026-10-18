# Additional owner origin for a scoped group relay

The default scoped transport admits only the connected account's own messages.
An explicit owner instruction can authorize one additional owner number as an
inbound author, without changing the account used for replies or group bindings:

```json
{"additionalOwnerAuthors":{"ids":["15550000002@c.us"],"since":"2030-01-01T12:00:00.000Z"}}
```

Keep real configuration in a private overlay. Verify the number from existing
owner/account records and authenticated group metadata; membership alone is not
an ownership grant. Never infer extra owners from other groups or contact names.
Use a fresh activation cutoff: earlier messages from that author are not replayed.

Incoming messages require the exact approved author and an existing permitted
group. A hidden LID is accepted only after the authenticated provider maps that
exact LID to the approved phone ID. Missing, conflicting or failed mappings are
rejected. Quoted content cannot establish sender identity. The original account
identity, outbound parent proof, durable send journal and echo checks still apply.
An uncertain delivery blocks further attempts; account changes must never replay it.

Install exact reviewed source through the release train with protected config and
journal backups. Pause the relay, ensure no sending/uncertain records, replace only
the bridge's code and author config, and restart the existing bridge once. Check
live account readiness, author count, immutable group bindings and receipts before
resuming the relay. On failure restore previous code/config, preserving journals;
never restore older delivery records or reset a session. Verify both origins with
fresh owner messages, not generated impersonations. Returning to another sending
account remains a separate provider-eligibility and route-cutover decision.
