# Passive Claude quota projection

The service broker can project quota from already-running Claude sessions into
the existing V1 `/api/quota/providers` snapshot and WhatsApp footer. It creates
no provider request, canary, thread, run, message or execution authority.
The existing canary and ordinary Claude work use the same broker path.

The codec validates native session identity, initialized/active state and the
unique telemetry UUID before projecting known five-hour and whole-account
seven-day numeric usage, reset, status and observation time. It never forwards
the raw native event or selected-account object. Model-specific weekly windows
are ignored. Percentages are never inferred from token counts or an allowed or
rejected status. The stripped broker/Rust protocol remains unchanged; projected
metadata cannot initialize, renew, finish or cancel a turn. Sink errors are
isolated while native stop/control refusals still propagate.

The protected selected-service plan optionally includes:

```json
{
  "claude_quota_projection": {
    "directory": "/srv/orkestr-quota/example-owner",
    "account_ref": "22222222-2222-4222-8222-222222222222"
  }
}
```

The operator enrolls the opaque account reference for that package's verified
Claude account directory; change the reference on an account change. The broker
checks the Core owner from its validated channel against the protected package
owner. Neither a browser, model nor native event selects the sink or account.

Create the directory before activation, owned by the service UID with no group
write or world permissions (0700, or 0750 with scoped reader ACLs). It must be
outside the sealed package, Core state, manager endpoints/ledger, provider home,
Claude account/home/temporary directories and selected workspace. Sharing this
metadata must never relax their existing private permission checks. The sink
uses a directory descriptor, no-follow regular single-link files, a nonblocking
lock and atomic replacement of `claude.json` (0640; directory access remains
scoped). It retains at most two minimized window records, with no credentials,
raw events, prompts, native-session IDs or email addresses. The cache is
informational, not durable execution evidence. Its opaque owner/account refs
never appear in the quota API or footer.

V1 reads the file through an operator-owned, non-writable, non-public JSON
configuration named by `ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG`:

```json
{
  "format": "orkestr-provider-quota-sources-v1",
  "sources": [{
    "ownerUserId": "example-owner",
    "coreOwnerId": "11111111-1111-4111-8111-111111111111",
    "accountRef": "22222222-2222-4222-8222-222222222222",
    "producerUid": 1000,
    "path": "/srv/orkestr-quota/example-owner/claude.json"
  }]
}
```

This is a local file pull: no HTTP credential, endpoint or extra polling process
is needed. Reads use the existing 30-second snapshot cache and normal quota
requests. The loader requires the authenticated V1 owner, enrolled Core owner,
opaque account ref, producer UID, private file custody and closed bounded data
shape. Missing, malformed or unreadable projection leaves existing telemetry
unknown/stale and cannot fail the request.
Exactly one Claude account source may be enrolled per V1 owner. Once a valid
projection is present, its account-scoped windows replace legacy Claude thread
quota: old thread records lack a verified account reference and cannot backfill
missing windows or override the projection during footer enrichment. Without a
valid projection, existing legacy behavior remains available.

Each period keeps its own observation time, including through later caller
thread enrichment. An unrelated window or changed file mtime never refreshes an
old percentage. The existing public schema stays unchanged: the aggregate
`observedAt` is the oldest selected window observation and `stale` uses the
existing six-hour threshold. Thus one fresh period cannot conceal an older
period. Absent windows stay null; expired reset windows are unknown. Existing
reset-window ordering and rate-limited profile state are preserved.

Deployment is one coordinated reviewed train updating the V2 broker package
and V1 snapshot reader, with private directory/config/ACL enrollment. It needs
both components updated, rather than a separate quota-only restart. If V1 runs
under a different UID, grant read/traverse only on this projection directory and
its files, using an appropriate default reader ACL for atomic replacements.
After activation, accept only an actual event from the next existing canary or
ordinary Claude session and verify its timestamp/reset values through V1 GET.
No manual provider probe is part of acceptance; until such data exists there is
no fresh quota claim. Real bindings and configuration remain in operator state.

## Codex projection

The Codex service broker projects the same way from Codex app-server's
`account/rateLimits/updated` notification (`broker/codex_quota.py`, shipped in
every service package). Only the account-wide bucket (`limitId` absent or
`codex`) is used; windows are classified by `windowDurationMins` (at most 360
is five-hour, at least 10080 is weekly). Model-specific limits, credits and plan
data are never copied, and no status is inferred. The notification is never
forwarded and cannot start, renew, finish or cancel a turn.

The protected selected-service plan optionally includes
`"codex_quota_projection": {"directory": ..., "account_ref": ...}` with the
same custody rules as the Claude binding; the directory additionally must not
overlap the real host `HOME`/`CODEX_HOME`. The sink writes `codex.json` under its
own `.codex-quota.lock`, so it may share the Claude projection directory.

V1 enrolls it as a second source with `"provider": "codex"` (a source without
`provider` stays Claude). One source per owner and provider is allowed. A valid
Codex projection replaces legacy V1 thread Codex telemetry, which ages out once
Codex no longer runs on V1 threads.
