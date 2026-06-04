# Router Trace Runbook

This runbook covers the public-safe router trace ledger used by WhatsApp and
future chat connectors. It stores delivery identifiers, phases, turns, and
outbox state under `ORKESTR_HOME/router-traces.json`.

## Retention

- `ORKESTR_ROUTER_TRACE_RETENTION`: maximum trace and turn records, default
  `1000`, bounded between `100` and `20000`.
- `ORKESTR_ROUTER_OUTBOX_RETENTION`: maximum outbox records, default follows
  trace retention.
- `ORKESTR_ROUTER_TRACE_STUCK_MS`: age threshold for stuck diagnostics, default
  `600000` milliseconds.

The ledger is a projection. Append-only events are also emitted to
`events.jsonl` with `router_trace_event` and `router_trace_stuck`.

## Incident Queries

List recent traces:

```bash
curl "$ORKESTR_API_BASE/api/router-traces"
```

List stuck traces:

```bash
curl "$ORKESTR_API_BASE/api/router-traces?stuck=true"
```

Inspect one timeline:

```bash
curl "$ORKESTR_API_BASE/api/router-traces/<routerTraceId>"
```

Run diagnostics:

```bash
curl "$ORKESTR_API_BASE/api/router-traces/diagnostics"
```

## Recovery Policy

Diagnostics only suggest recovery. They do not re-inject user messages, reset
threads, delete outbox rows, or send connector messages.

- `queued` or `delivery_started`: check runtime health and retry the delivery
  queue.
- `delivered_to_runtime`: inspect runtime output before retrying; the runtime
  may already have seen the turn.
- `mirror_claimed` or `mirror_failed`: check connector status and retry the
  durable outbox item.
- `runtime_failed`: repair or restart the runtime, then explicitly retry if the
  user still expects a reply.

## Alerts

Alert on sustained `router_trace_stuck` events or when
`/api/router-traces/diagnostics` reports `metrics.stuck > 0` for longer than one
stuck threshold window.
