# Ordinary Fast presentation

The default server can configure separate Fast and Deep native sessions for one
canonical conversation. Private isolated-factory configuration selects
`"role": "fast"`; omission preserves Deep. Fast currently requires Codex and
refuses Worker policy. Each role needs its own supervisor key, execution context,
native binding, writable home and temporary directory. The existing execution-set
limit remains sixteen factories, counting both roles.

Owner input still enters the ordinary conversation once. Fast selects that
immutable source independently, using durable run history to exclude every
already-admitted source and respecting ordinary held input. It never claims or
acknowledges the Deep inbox. A Fast proposal waits for explicit owner acceptance;
only then can the same native child present another eligible input. Acceptance
applies to that Fast reply and does not certify Deep or Worker work.

## Browser contract

- `GET /api/v2/conversations/{id}/fast/execution` returns the existing execution
  status DTO for the current Fast context. With `run_id`, it selects only that
  exact context's run. A known conversation without Fast configuration returns
  204; foreign conversations and cross-role run locators return 404.
- `POST /api/v2/conversations/{id}/fast/stop` uses the existing immutable control
  request tuple and authenticated origin guard. It targets only the configured
  Fast registry and scheduling lock. Deep Stop remains independent.
- `POST /api/v2/conversations/{id}/accept` accepts the exact Fast candidate through
  the ordinary authenticated acceptance transaction. There is no new acceptance
  authority, role selector or private configuration in browser requests.

No Fast run is represented as Deep inbox queue work. Fast status and control
authentication are checked against the current machine context as well as the
browser owner. Revocation fences both separately configured roles.

## Native lifecycle and limits

Fast uses the persistent wrapper described in
[fast-session-wrapper.md](fast-session-wrapper.md). It renews quiet running work
without replacing the native child or extending the configured work budget.
Stop requires the actual interruption acknowledgement, matching terminal evidence
and original child cleanup. ACK-only delivery stays unconfirmed and cannot
automatically start a replacement. A genuine Stop may resume the same native
session for a fresh eligible input after the old tree is reaped.

After explicit acceptance, graceful shutdown records retirement only after the
original child is reaped. Restart reattaches the exact predecessor, preserving
the role and native identity, and waits for fresh eligible input before launching.
Idle setup, an unaccepted proposal, and a stopped-only shutdown do not yet have
equivalent configured-restart evidence; unsafe replacements remain refused.
Fast steering and actual-provider qualification are separate remaining work.

## Validation boundary

`owned_fast` drives the real default server and authenticated HTTP routes with
synthetic native executables. Six scenarios cover independent presentation,
two-role accepted restart, selective Fast Stop/resume, ACK-only refusal,
revocation and a quiet turn spanning the twenty-second renewal interval. They
check durable ledgers, original child cleanup, same-child accepted continuation,
cross-role refusal and unchanged Deep inbox state. Sequential process identity
uses verified host PID/start pairs; a namespace inode can be recycled after reap.

Read-only ledger snapshots use one transaction. The standalone driver accepts
`--report` to retain case-level ledger, native trace and cleanup evidence. This
bounded synthetic qualification does not establish real-provider, browser,
performance, stopped-only restart or full-release readiness.
