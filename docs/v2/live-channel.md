# Browser live channel

Status: protocol 1, 2026-11-26. Replaces the browser's fixed-interval polling
with one push channel per tab. The browser still reads every resource through
the same GET routes; the channel only says *when* to read.

## Why

One open conversation tab used to make 145–200 API requests a minute (about
25 MB/h): the sidebar every 4 s, conversation status every 10 s, execution,
intelligence and worker task status every 1.5–2 s, posts every 3 s, and an event
stream that ended after 25 s of quiet and was reopened with a catch-up read.
Behind a TLS-inspecting corporate proxy the event stream was also buffered, so
updates arrived only with the 25 s catch-up, and the proxy kept server-side
streams open for minutes after the browser had given up.

## Transport

| Route | Transport | Notes |
|---|---|---|
| `GET /api/v2/live` | WebSocket (primary) | Requires the browser session cookie and an `Origin` equal to the configured origin (cross-site WebSocket hijacking). |
| `GET /api/v2/live/events` | Server-sent events (fallback) | Same session check. Starts with a 2 KiB comment, sends `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`. |

Both routes refuse machine `Authorization` credentials: the channel belongs
to a browser session. Every frame is written and flushed on its own (no
WebSocket write buffering; one SSE event per body chunk). The browser prefers
the WebSocket because a buffering proxy cannot hold back frames of an
upgraded connection; it uses the event stream when the upgrade fails and
falls back to slow polling when neither delivers a heartbeat.

Query parameters of both routes: `w=<path>` (repeatable, URL-encoded; the
initial watch set), `resume=1` (the browser is reconnecting),
`fallback_polls=<n>` and `reconnects=<n>` (counts the browser made while its
channel was down; see [metrics](#metrics)).

## What a channel watches

The browser names the exact GET paths (path and query) it would otherwise
poll. Accepted routes (everything else is answered with `refused`):

- `/api/v2/sidebar`, `/api/v2/conversation-status`, `/api/v2/provider-quotas`,
  `/api/v2/sites`, `/api/v2/live-map`, `/api/v2/resources`,
  `/api/v2/host-metrics` and its `consumers`, `disks` and `history` reads;
- `/api/v2/timers/{id}`;
- `/api/v2/conversations/{id}` (snapshot pages) and its `execution`,
  `fast/execution`, `intelligence`, `worker-tasks`, `workers`,
  `held-inputs`, `posts`, `message-times`, `window`, `window/queue`,
  `v1-workers`, `updates` and `accepted-results` reads.

At most 32 paths per channel, each at most 2,048 bytes.

The server reads a watched path through the same API router, with only the
browser's `Host` and `Cookie`, so the read performs the same owner, session
and conversation checks as the browser's own request: a channel can only
report on what its session may read, and a path the session may not read
fingerprints as its error status. These reads bypass the request log and the
request metrics (they are counted separately).

Each answer gets a fingerprint:

- `W/"…"`: the weak `ETag` the browser receives for the same successful read;
- `~…`: a digest of a successful JSON answer with its read-time samples
  (`observed_at_ms`, `queue_age_ms`, `generated_at_ms`) left out, so a new
  read time alone is not a change (host metrics keep their sample time: a new
  sample is a change; the conversation status also leaves out process CPU and
  memory samples, which its sidebar badges do not show);
- `<status>:…`: a digest of an unsuccessful answer.

### When the server reads

SQLite update, commit and rollback hooks on every pooled Core connection
count committed changes (`ChangeFeed` in the store). Writes that only renew
liveness (`auth_sessions`, supervisor and run lease tables) are not counted.
After a counted commit the channel re-reads its paths after 150 ms (one read
per burst) and once more 1 s after the last change of the burst, so a commit
that was not yet visible at the first read is not missed. A path is read at
most once per 40× its last read time (between 2 s and 15 s), so an
expensive read such as a 50-row conversation status runs at most every ~10 s
however busy the store is. Answers that also depend on state outside the
store are re-read periodically without a change: the sidebar, live map and
V1 workers every 10 s, host metrics every 15–60 s, the conversation status
every 30 s, quotas and sites every 60 s, everything else every 30 s. Reads
run one at a time per channel and at most two at a time across channels,
and a channel spends at most 5 % of wall time on reads (after a burst of
1.5 s), so a store that is written all the time cannot make a channel
expensive.

## Frames

JSON objects with a `t` type. Over a WebSocket each frame is one text
message; over the event stream it is the `data` of an event named after `t`.

Server to browser:

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `v` (1), `channel`, `transport`, `heartbeat_ms` (12,000), `max_paths` | First frame. |
| `hb` | `at_ms` | Every 12 s. The session is re-checked first. |
| `watching` | `paths: [{path, fp}]`, `recent` | First fingerprints of newly watched paths. `recent`: a change was committed in the last 5 s, so a browser that cannot compare `fp` with the `ETag` it holds refetches once. |
| `changed` | `paths: [{path, fp}]` | These answers changed: refetch them. |
| `refused` | `path`, `reason` (`not_watchable`, `limit`) | Not watched. |
| `expired` | | The browser session ended; the channel closes. |
| `bye` | `reason` (`lifetime`, `replaced`, `shutdown`) | The server closes; reconnect. |

Browser to server (WebSocket only; the event stream takes its watch set from
the query and is reopened when it changes):

| `t` | Fields | Meaning |
|---|---|---|
| `watch` | `add: [path]`, `remove: [path]` | Change the watch set. |
| `report` | `fallback_polls`, `reconnects` | Counts since the last report. |
| `hb` | | Optional liveness; WebSocket pongs count too. |

## Liveness and cleanup

- The server sends `hb` and a WebSocket ping every 12 s. A WebSocket without
  any frame or pong from the browser for 45 s is closed (`idle`). A write that
  does not complete within 10 s closes the channel (`write_error`); a failed
  event-stream write drops the stream and its session.
- A WebSocket lives at most one hour, an event stream five minutes (`bye
  lifetime`): behind a buffering proxy the server cannot tell whether anybody
  still reads an event stream.
- At most 16 channels are open; a new one replaces the oldest (`bye
  replaced`).
- On shutdown every channel gets `bye shutdown` before the HTTP drain.

## Browser behaviour

- One channel per tab, owned by a page-wide script; every poller waits on it
  instead of a timer and fetches only when its path changed, plus one
  catch-up after a reconnect.
- The browser records the `ETag` of its own reads. A `changed` or `watching`
  fingerprint equal to that `ETag` needs no refetch.
- No frame for 30 s (2.5 heartbeats) means the channel is stalled: the
  browser closes it, reconnects with backoff (1 s doubling to 60 s, with
  jitter; at once on focus, visibility or network return) and meanwhile
  polls every watched path on a slow fallback timer (30 s, or the poller's
  old interval if that was longer). After a stall over a WebSocket it tries
  the event stream, then the WebSocket again on the next reconnect.
- A server without the channel (`404`) leaves the browser on its previous
  polling intervals.

## Metrics

On the local metrics listener (`/metrics`, and `live` in
`/metrics.json`):

| Metric | Meaning |
|---|---|
| `orkestr_v2_live_channels{transport}` | Open channels. |
| `orkestr_v2_live_channels_opened_total{transport}` | Channels opened. |
| `orkestr_v2_live_reconnects_total` | Opened with `resume=1`. |
| `orkestr_v2_live_frames_total{type}` | Frames pushed by type. |
| `orkestr_v2_live_invalidations_total` | Paths reported changed. |
| `orkestr_v2_live_reads_total`, `orkestr_v2_live_read_seconds_total` | Server-side fingerprint reads. |
| `orkestr_v2_live_closed_total{reason}` | `client`, `write_error`, `idle`, `lifetime`, `expired`, `replaced`, `shutdown`, `protocol`. |
| `orkestr_v2_live_fallback_polls_total` | Fallback polls browsers reported. |
| `orkestr_v2_live_client_reconnects_total` | Reconnect attempts browsers reported. |

The per-route request series (`orkestr_v2_http_requests_total`) show the
effect: with healthy channels the polled routes drop to their change rate.

## Reverse proxy

The channel lives under `/api/v2/`, so an existing `/api/v2/*` route covers
it. Caddy's `reverse_proxy` passes WebSocket upgrades without extra
configuration and `flush_interval -1` keeps event streams unbuffered. An
authentication gate in front (`forward_auth`) sees the upgrade request as a
normal GET. A proxy that rewrites `Origin` must map the site's origin onto
the configured one, as for any browser write.
