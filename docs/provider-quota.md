# Provider Quota Display

Orkestr threads can run on two subscription-backed executors: Codex (OpenAI
subscription) and Claude Code (Anthropic subscription). Orkestr does not fail
over between them automatically. Instead it always shows the remaining quota of
**both** providers so the owner can decide when to move a thread to the other
executor (`/agent claude|codex`, or the `/claude` and `/codex` aliases).

## Data source

`packages/core/src/provider-quota-snapshot.js` builds an account-level snapshot
per owner:

- Codex: the most recently observed `codexRateLimits` across the owner's
  threads (Codex app-server `thread/tokenUsage/updated` or rollout
  `token_count` metadata). Rate limits are account-wide, so any thread's latest
  observation applies to all threads.
- Claude: the most recently observed `claudeRateLimits` across the owner's
  Claude Code threads (stream-json telemetry), plus the Claude account profile
  state (`rate_limited` is surfaced as `limited`).
- Remaining percent is `100 - used_percent`, clamped to 0-100. Windows whose
  reset time has passed, invalid percentages, and missing windows are reported
  as unknown (`null`), never guessed.
- Telemetry writes stamp `codexRateLimitsObservedAt` /
  `claudeRateLimitsObservedAt`. Older records fall back to the thread's last
  update time, and only for the thread's active executor.
- An observation older than `ORKESTR_PROVIDER_QUOTA_STALE_MS` (default 6 hours)
  is marked `stale`. Snapshots are cached for
  `ORKESTR_PROVIDER_QUOTA_CACHE_MS` (default 30 seconds).

## WhatsApp debug footer

When the debug footer is enabled, every Codex and Claude reply shows the active
agent, its model/effort, and both providers' remaining quota. Reset times are
shown only for the active provider. `?` means unknown; `(stale)` and
`(limited)` mark old observations and rate-limited accounts.

```text
dbg: m:gpt-5.5/xh · agent:codex · rt:api · msg:final · codex 5h:62% wk:80% 5h-reset:12 Jan 14:00 UTC wk-reset:15 Jan 09:00 UTC · claude 5h:41% wk:77% · q:0 · load:20% · api:3% · help:/help · mode-switch:/plan · rt-switch:/switch-terminal · switch:/claude
dbg: m:sonnet/m · agent:claude · rt:claude · msg:final · codex 5h:62% wk:80% (stale) · claude 5h:41% wk:77% 5h-reset:12 Jan 13:00 UTC · q:0 · load:20% · api:3% · help:/help · switch:/codex
```

Codex-only controls (fast mode, plan/code mode, runtime switch) remain limited
to Codex threads. Existing footer gating and per-chat suppression still apply.

## API and web UI

- `GET /api/quota/providers` returns `{ quota: { codex, claude } }` for the
  current owner (admins may pass `ownerUserId`). Each entry contains
  `fiveHourRemainingPct`, `weeklyRemainingPct`, `fiveHourResetsAt`,
  `weeklyResetsAt`, `observedAt`, `stale`, `limited` and `source`. Raw
  telemetry and credentials are never returned.
- The thread header shows a compact Codex/Claude quota indicator with reset
  times and freshness on hover. The model card labels the active executor and
  shows the Claude model/effort on Claude threads.
