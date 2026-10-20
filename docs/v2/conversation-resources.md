# Conversation resources: desktops, V1 workers and per-conversation controls

Migration 0050 adds three owner-scoped resources to a V2 conversation. None of
them admits input, starts execution or creates effects.

## Per-conversation controls (V1 thread controls parity)

`GET/PUT /api/v2/conversations/{id}/settings` (owner Bearer or browser cookie +
CSRF). `PUT` is a full replacement guarded by `expected_revision` (0 while the
conversation still uses defaults); an identical replay at the previous revision
is idempotent, any other stale write is `409 settings_revision_mismatch`.

| Field | V1 source | Rule |
| --- | --- | --- |
| `provider` | `executorId` / `orkestr switch` | `codex` (default) or `claude` |
| `model` | `codexModel` / `claudeModel` | `[A-Za-z0-9._:-]{1,120}`, not all digits, not a provider name; `null` = installation default |
| `reasoning_effort` | `codexReasoningEffort` / `claudeEffort` | Codex: `none minimal low medium high xhigh max ultra`; Claude: `low medium high max`; `null` = default |
| `honor_no_reply` | `no-reply.js` | default `true`: an assistant answer whose trimmed text is exactly `NO_REPLY` (case-sensitive) is not delivered |
| `reply_prefix` | binding `replyPrefix` | ≤64 bytes, one line; added as `"{prefix} {text}"` unless the text already starts with it (ASCII case-insensitive) |
| `reply_footer` | WhatsApp footer | ≤512 bytes, newlines allowed; appended after a blank line |

`provider_generation` increments on every provider change. As with V1
`orkestr switch` (`after_turn`), a running turn is never mutated.

Launch wiring: the dispatch transaction that consumes a Deep or Worker turn
reads the settings (`ConsumedProviderDispatch::launch()`, a `TurnLaunch`), so
a change applies from the next turn. Codex turns carry `model` and `effort` as
`turn/start` overrides exactly like V1 `turnStartParams`; Runtime and the
provider broker accept only a valid model name and a Codex effort there, and
nothing else (sandbox, cwd and approval stay operator-owned, so
`host_full_access` is unaffected). Fast turns keep their pinned launch. A
conversation set to Claude never sends its Claude model/effort to Codex
(`TurnLaunch::codex_overrides`); the Claude runtime reads the same `TurnLaunch`
and `requires_switch_from` to start the next turn on Claude with a one-time
handoff. Until the server is started `with_claude_turns()` (the installed
Claude execution path), selecting Claude is refused with
`409 provider_unavailable`, as V1 refuses a switch it cannot start.

`POST /api/v2/conversations/{id}/settings/render` with `{"text": ...}` returns
`{"outcome":"deliver","text":...}` or `{"outcome":"suppressed","reason":"no_reply"|"empty"}`
plus `settings_revision`, so any delivering adapter applies the same canonical
rules (`ConversationSettings::render_reply`). The multi-chat WhatsApp adapter
(`v2/compat/v1_runtime`) renders every exported final reply, including timer
replies, through it: suppressed answers are exported as V1's silent
`NO_REPLY`; prefix and footer are applied once. Intermediate progress keeps
only the `NO_REPLY` rule. Against a server without the route (404) the adapter
keeps V1's `NO_REPLY` rule only.

## Browser desktops during the parallel run

V1's lease broker (`/api/desktops/*` on V1 loopback) stays the authority.
V2 never launches Chrome, never copies or reads profiles and never returns
noVNC/CDP endpoints.

1. Operator: `ORKESTR_V2_DESKTOP_BROKER_CONFIG=/private/desktop-broker.json`, a
   regular `0600` file owned by the service user:
   `{"v1_url":"http://127.0.0.1:<port>","bearer_token":"<V1 operator token>"}`.
   Only `http://` IPv4 loopback is accepted. Without it, lease routes return
   `503 desktop_broker_unconfigured`.
2. Owner binds the conversation to exactly one V1 thread identity and slugs:
   `PUT .../desktop-binding {"expected_revision":0,"v1_thread_id":"…","desktop_slugs":["…"]}`.
   Every slug must be in V1's grant for that thread
   (`GET /api/threads/:id/desktop-grants`, `acquire` permission), else
   `403 desktop_not_granted_by_v1`. A V1 thread can be bound to only one
   conversation, so two conversations can never share (and silently renew)
   one V1 lease.
3. Owner issues the conversation desktop grant: `POST .../desktop-binding/grant`
   (201, shown once, stored hashed; rotating invalidates the previous one;
   `DELETE` revokes). Put it in the conversation Worker's environment as
   `ORKESTR_V2_DESKTOP_GRANT` (operator/credential additions), never in a repo.
   The grant authorizes only this conversation's lease routes; it is not owner
   authority and is refused together with a cookie, Authorization or Origin.
4. Worker: `python3 v2/tools/desktop_lease.py --v2-url … --conversation … hold
   SLUG --ttl-ms 1800000 -- COMMAND`. It acquires, exports
   `ORKESTR_DESKTOP_SLUG`, `ORKESTR_DESKTOP_THREAD_ID`,
   `ORKESTR_DESKTOP_FENCING_TOKEN` and `ORKESTR_DESKTOP_FENCING_VERSION` to the
   command (which uses the managed noVNC/V1 browser actions with that thread id
   and fencing token), heartbeats with expiry renewal, stops the command if the
   lease is lost (exit 75) and always releases.

Routes (`/api/v2/conversations/{id}/…`): `GET desktops`,
`POST desktops/{slug}/acquire {ttl_ms, purpose?}` (201, returns the V1
`fencing_token` once), `POST desktops/{slug}/heartbeat {fencing_token,
extend_ttl_ms?}`, `POST desktops/{slug}/release {fencing_token, reason?}`.

Fencing: V2 stores only a hash of V1's fencing token. A wrong token is refused
by V2 (`409 desktop_fence_rejected`) before V1 is contacted. V1 heartbeat does
not extend expiry, so `extend_ttl_ms` re-acquires for the same thread and must
get back the same token and version. V1 reporting a stale token (404) or
another holder (409) ends the V2 row as `lost` (`409 desktop_lease_lost`).
A V1 lease that V2 fails to record is released at V1 immediately. Ended rows
are immutable; one active V2 row per slug.

## V1 worker sub-threads

When a parent thread moves to V2, its V1 workers (`threadKind: worker`,
`parentThreadId` = parent) become links under the parent's conversation:

| V1 worker | V2 |
| --- | --- |
| retired | `archived`: history imported as archived history (`source_thread_id` = worker id) |
| active (default) | `finish_in_v1`: keeps running in V1; when a later snapshot shows it retired it becomes `archived` |
| active, chosen | `recreate_in_v2`: retired in V1 by the operator, then continued as a V2 Worker task under the parent run and linked (`link_task`) |

Worktree ownership has exactly one writer: `v1`, `v2` or `none`.
`release_v1_worktree` requires the worker retired in a fresh V1 snapshot;
`claim_v2_worktree` requires `none`, a recorded path, no `finish_in_v1`
disposition and no other V2 claim on the same path (unique index). Rollback is
`release_v2_worktree` then `return_v1_worktree`. A V1 restore of a worker whose
worktree V2 claimed (or whose V2 task is linked) is refused at registration.
Every change is revision-guarded and recorded in an append-only audit table.

API: `GET/POST /api/v2/conversations/{id}/legacy-workers` (register a V1
snapshot; per-worker `inserted|updated|unchanged|conflict`; identity changes
are conflicts) and `POST …/legacy-workers/transition`.

Operator workflow (`v2/migration/thread_workers.py`, dry-run by default):

```sh
python3 -B v2/migration/thread_workers.py plan --v1-home V1_HOME --parent PARENT
python3 -B v2/migration/thread_history.py v1-export --v1-home V1_HOME --thread W1 --thread W2 … --out BUNDLE
python3 -B v2/migration/thread_workers.py apply --v1-home V1_HOME --parent PARENT \
  --conversation PARENT_CONVERSATION --bundle BUNDLE [--recreate W] \
  [--transfer-worktree W] --v2-url … --credentials-file … --apply
```

The 32-tasks-per-parent-run limit of V2 Worker tasks means only the workers
that must continue are recreated; the rest finish in V1 or stay archived.
