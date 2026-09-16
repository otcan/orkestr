# WhatsApp Provisioning Runbook

Use this runbook to inspect WhatsApp account health and generated group
provisioning without changing a browser, linked device, or group.

## Read-Only Diagnostics

Run a scoped diagnostic for one account:

```bash
orkestr whatsapp accounts diagnostics <account-id> --json
```

The diagnostic is forced and read-only. It reports separate `auth`, `read`,
`send`, `inbound`, and `groupCreate` capability states plus opaque runtime
provenance with an observation time and generation. It must not restart a
runtime, reset a browser, clear a QR, or relink an account.

Interpret account state as follows:

- `auth_failure` with `whatsapp_session_logout_verified`: explicit logout or
  authentication failure was observed. Pairing is required.
- `disconnected`: a transport, navigation, timeout, or other non-auth
  disconnect was observed. Do not treat it as proof of logout.
- `degraded`: a fresh read-only chat-operations probe failed while the runtime
  remains present. Sending may still be available; do not infer that group
  creation is available.

An unrelated account's QR or pairing state is not evidence about the selected
account. Inspect the selected account again before any explicit repair.

## Group Provisioning

Generated-group operations persist `prepared`, `dispatched`, `created`,
`bound`, `rejected`, or `outcome_unknown` state with the selected principal,
instance, account, and thread identity.

- `prepared` or `dispatched`: wait for the existing operation. Do not create a
  second group.
- `created`: the group ID is durable but binding or optional setup needs to be
  resumed using the same operation context.
- `bound`: the thread already has its generated group.
- `rejected`: external dispatch did not occur. Correct the reported capability
  issue before retrying.
- `outcome_unknown`: do not retry or use a force-new option. Reconcile through
  one bounded, authoritative, read-only worker result. Group title searches
  are not identity evidence.

The service accepts only complete supported WhatsApp group IDs. SDK strings,
partial IDs, malformed results, and transport failures remain
`outcome_unknown`; they are never treated as proof that a group was not
created.

## Repair Boundary

Ordinary diagnostics never repair. Any account reset, browser restart,
relink, or group mutation must be an explicit, separately authorized action
after reviewing the selected account's current diagnostic and the durable
operation state. Do not use runtime paths, browser endpoints, local profiles,
or session material as operational evidence or include them in reports.
