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

When the debug footer is enabled, every reply carries both providers' remaining
quota and reset countdowns, so the owner can see when the other provider's
quota returns before switching. `(stale)` and `(limited)` mark old
observations and rate-limited accounts; a provider without data reads
`no data`. The full layout, the same in every chat, is in
[whatsapp-remote-footer.md](whatsapp-remote-footer.md).

```text
⚡ Quick: codex gpt-6-luna · 🧠 Deep: codex gpt-6.1-sol · ▶ Deep
codex wk: 80% (2d3h)
claude 5h: 90% (1h30) wk: 70% (4d2h)
q:0 · load:20% · api:3% · help:/help
```

Tenant isolation and per-chat suppression still apply.

## API and web UI

- `GET /api/quota/providers` returns `{ quota: { codex, claude } }` for the
  current owner (admins may pass `ownerUserId`). Each entry contains
  `fiveHourRemainingPct`, `weeklyRemainingPct`, `fiveHourResetsAt`,
  `weeklyResetsAt`, `observedAt`, `stale`, `limited` and `source`. Raw
  telemetry and credentials are never returned.
- The thread header shows a compact Codex/Claude quota indicator with reset
  times and freshness on hover. The model card labels the active executor and
  shows the Claude model/effort on Claude threads.
