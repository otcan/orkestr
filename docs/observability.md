# Observability

Orkestr exposes public-safe runtime telemetry for self-hosted operators. The
OSS app provides metrics and structured signals; operators choose where to
store dashboards, logs, and alerts.

## Metrics Endpoint

The server exposes OpenMetrics-compatible text at:

- `/metrics`
- `/api/metrics`

Default access is local-only. Remote scraping requires one of:

- `ORKESTR_METRICS_TOKEN=<token>` and `Authorization: Bearer <token>`
- `ORKESTR_METRICS_PUBLIC=1` for trusted private networks only

Disable the endpoint with:

```bash
ORKESTR_METRICS_ENABLED=0
```

State gauges scan thread records and bounded pending-message candidates. Tune or
disable that scan with:

```bash
ORKESTR_METRICS_STATE_ENABLED=1
ORKESTR_METRICS_QUEUE_STATE_ENABLED=1
ORKESTR_METRICS_MAX_THREADS=250
ORKESTR_METRICS_QUEUE_TAIL_LIMIT=500
```

## Metric Families

- `orkestr_http_requests_total`: HTTP request count by method, scrubbed route,
  and status class.
- `orkestr_http_request_duration_seconds`: HTTP request duration histogram.
- `orkestr_http_response_size_bytes`: HTTP response size histogram.
- `orkestr_threads_current`: current threads by public kind and state.
- `orkestr_runtime_threads_current`: current runtime threads by public kind and
  runtime state.
- `orkestr_thread_pending_inputs_current`: queued or in-flight user inputs by
  state, delivery state, and connector type.
- `orkestr_background_loop_runs_total`: runtime, timer, and scheduler loop run
  counts.
- `orkestr_background_loop_duration_seconds`: background loop duration
  histogram.
- `orkestr_background_loop_items_total`: loop item counts such as recovered
  inputs or delivered timer prompts.
- `orkestr_whatsapp_delivery_runs_total`: WhatsApp delivery pass counts.
- `orkestr_whatsapp_delivery_messages_total`: WhatsApp sent, failed, and skipped
  message counts.
- `orkestr_task_agent_lifecycle_total`: task-agent lifecycle transitions.
- `orkestr_watcher_alerts_total`: watcher alert counts by source and code.
- `orkestr_shadow_boundary_chat_warnings_total`: opted-in shadow target warning
  outcomes by resource type. It never labels a thread, target, or chat.

Routes and labels intentionally avoid thread IDs, chat IDs, account IDs,
desktop slugs, hostnames, and personal names.

## Structured Access Logs

Set this to write one JSON line per HTTP request:

```bash
ORKESTR_STRUCTURED_ACCESS_LOGS=1
```

The log entry includes request id, method, scrubbed route, status code,
duration, response size, and timestamp.

## Perf Log and `orkestr doctor perf`

The server keeps a durable performance record on the box it runs on, enabled
by default (`ORKESTR_PERF_LOG=0` turns it off):

- `ORKESTR_HOME/observability/requests-YYYY-MM-DD.jsonl`: one line per HTTP
  request with time, method, normalized route template, status (0 when the
  client aborted), duration, response bytes, auth kind (`user`, `machine`,
  `share`, `anonymous`, `none`) and the in-flight request count. Query strings,
  bodies, headers, tokens, user ids and long or token-like path segments are
  never written.
- `ORKESTR_HOME/observability/health-YYYY-MM-DD.jsonl`: a sample every
  `ORKESTR_PERF_SAMPLE_INTERVAL_MS` (default 30000) with host load, CPU,
  memory, swap and disk, the busiest process names by CPU over the interval
  (names only, never command lines), and the Orkestr server's CPU, RSS/heap,
  event-loop delay, in-flight requests and sqlite store sizes.

Files are 0600 in a 0700 directory and are pruned after
`ORKESTR_PERF_LOG_RETENTION_DAYS` (default 14, max 90). Writes are buffered
and appended every few seconds, off the request path.

`orkestr doctor perf [--window 15m|1h|6h|1d] [--json]` (admin API
`GET /api/system/perf?window=1h`) summarizes the window: overall latency
percentiles, routes by total time with p50/p95/max and 5xx counts, the
slowest requests, host and server health, and findings such as
`event_loop_blocked`, `cpu_saturated`, `swap_pressure`, `slow_route` and
`failing_route`.

## Self-Hosted Install Pattern

A minimal single-box stack is:

1. Prometheus or VictoriaMetrics scrapes `http://127.0.0.1:<orkestr-port>/metrics`.
2. Grafana reads from that metrics store.
3. Loki or journald collection stores Orkestr service logs.
4. Node exporter records host CPU, memory, disk, and network metrics.
5. Process exporter records Orkestr, browser desktop, and connector process
   resource use.

Example Prometheus scrape job:

```yaml
scrape_configs:
  - job_name: orkestr
    scrape_interval: 15s
    static_configs:
      - targets: ["127.0.0.1:19812"]
```

For remote scraping, prefer a private network plus `ORKESTR_METRICS_TOKEN`.

## First Alerts

Start with these alerts:

- HTTP 5xx rate above baseline.
- Runtime loop failures.
- Pending inputs nonzero for more than a few minutes.
- WhatsApp delivery failures or skips above zero.
- Watcher alerts above zero.
- High process CPU or memory sustained for several minutes.
- Desktop/noVNC process down while desktops are enabled.
