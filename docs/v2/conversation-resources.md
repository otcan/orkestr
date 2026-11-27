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
   A packaged service sets it through the selected plan key
   `"desktop_broker": "/private/desktop-broker.json"`. The packager copies only
   the path into `service.json`, never the file, and the manager passes it to
   the server environment.
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

### Sharing all desks with all chats

`GET/PUT /api/v2/desktop-sharing` (owner Bearer or browser cookie + CSRF; a
conversation desktop grant is refused) holds the owner's switch
`{"share_all_desks": bool, "revision": n}`. `PUT` takes
`{"expected_revision": n, "share_all_desks": bool}`; a stale revision is
`409 desktop_sharing_revision_mismatch`. The Virtual Desks page shows it as
"Share all desks with all chats".

- **On**: any conversation with a desktop binding may acquire any desk. The
  slug is not checked against the binding and V1's per-thread grant list is
  not read, so desks added later need no binding or grant change and the
  16-slug limit does not apply. The binding still supplies the V1 thread
  (the holder V1 sees) and the conversation desktop grant. V1 still decides
  every acquire under its own access policy (an enforced protected binding
  is still refused there, `403 desktop_denied_by_v1`) and remains the
  fencing authority. `GET …/desktops` reports `"shared_with_all_chats": true`.
- **Off** (default, no row): exactly the per-conversation rules above.
  Turning it off is refused with `409 desktop_shared_lease_active` while a
  conversation holds a desk its binding does not list; release that lease
  first. An acquire that started while it was on and is recorded after it
  went off is refused (`409 desktop_sharing_changed`) and released at V1.
- One holder per desk, fencing, heartbeat and release are the same either way.
- A binding may list no slugs (`"desktop_slugs": []`): it then names only the
  V1 thread, which is all a new conversation needs while sharing is on.
- Stored-login typing (desk-login automatic grants) stays governed by its own
  policy file; sharing a desk never widens which desks get stored logins.
  Native desktop control keeps its per-conversation configuration and V1
  operate grant.

Fencing: V2 stores only a hash of V1's fencing token. A wrong token is refused
by V2 (`409 desktop_fence_rejected`) before V1 is contacted. V1 heartbeat does
not extend expiry, so `extend_ttl_ms` re-acquires for the same thread and must
get back the same token and version. V1 reporting a stale token (404) or
another holder (409) ends the V2 row as `lost` (`409 desktop_lease_lost`).
A V1 lease that V2 fails to record is released at V1 immediately. Ended rows
are immutable; one active V2 row per slug.

V2 waits up to 20 s for V1's heartbeat and release (45 s for acquire). A
release that still times out answers `503 desktop_broker_unavailable` and
keeps the row active for a retry. Two rules keep such a row from blocking a
desk once V1 has let it go:

- Every acquire first ends all of the owner's active rows past their
  V2-observed expiry, on every desk (`lost`, `expired`), not only on the
  desk asked for.
- When the conversation's own active row blocks its acquire
  (`desktop_lease_held`), V2 reads V1's current lease of that desk. If V1 no
  longer holds exactly that lease (same V1 lease id, thread and fencing
  version), the row ends as `lost` (`v1_lease_gone`) and the acquire goes
  ahead. If V1 still holds it, or cannot be read, the refusal stands.

### Desk reservations between steps

A lease lasts one tool step. Between two steps of one chat, while a chat has
handed a desk to the owner, or while the owner views a desk, Core keeps a desk
reservation (migration 0104, table `desktop_reservations`). Every acquire
checks it, whichever tool takes the lease: V2 refuses before V1 is asked, and
the record of the lease checks again in the transaction that inserts the
lease row. A reservation made while V1 prepared the desk therefore ends that
acquire too: the row is not written and the V1 lease is released.

| Kind | Made by | Who may acquire meanwhile |
| --- | --- | --- |
| `task` | every recorded acquire of the chat, until 10 minutes past the lease's expiry but at most 120 minutes ahead; `reserve` (default 30, at most 120 minutes) | only that chat |
| `owner_handoff` | the chat's `handoff` (default 30, at most 120 minutes, or `until_ms`, for example a sign-in link's expiry) | no chat, the handing chat included (`desk_handed_to_owner`), until its `handback` (the desk is then its task for 10 minutes) or the end time |
| `owner_viewer` | the owner's viewing link: Link on Virtual Desks, or Open in a chat, until the link expires (60 minutes when V1 states no expiry, at most 120) or the owner ends viewing | only the chat that holds the desk's task. Opened from a chat, that chat gets the task for the window unless another chat already holds the desk |

- **Limits.** A desk has at most one claim (`task` or `owner_handoff`) and at
  most one `owner_viewer` window. A reservation ends at its time; nothing has
  to remove it.
- **Heartbeat and release.** A heartbeat with `extend_ttl_ms` extends the
  chat's existing task, never makes one, and extends nothing while the owner
  views the desk. When the step ends (release, or a lost lease), the task is
  cut back to 10 minutes from then, or to the end of an explicit `reserve` if
  that is later.
- **System steps.** An acquire with `"system_step": true` is refused like any
  step but makes or extends no task. Use it for a job's step on a chat's desk,
  such as a sync or a token renewal.
- **While the owner views a desk,** a chat that does not hold its task can
  neither `reserve` it nor hand it over (`409 desk_busy`). A reservation or a
  handoff followed by a handback would otherwise make it the holder.
- **Only the chat's own claim changes.** Another chat's claim answers
  `409 desk_busy` (reserve, handoff) or `409 reservation_of_another_chat`
  (unreserve).

A refused acquire (and a refused `reserve` or `handoff`) answers `409`. The body
has:

- `code`: `desk_busy` or `desk_handed_to_owner`;
- `message`: what holds the desk, and that nothing was done;
- `desk`;
- `holder`: `kind`, the holding chat's name as `chat` ("another chat" when it
  has none), `mine`, `since_ms`, `until_ms`. Another chat's conversation id is
  never included;
- for `desk_busy` only, up to three `free_desks`.

Free desks are the client's `candidates` first, then the chat's bound desks,
then desks it leased in the last 14 days. A desk is left out when another chat
holds it, it is handed over or viewed, a step is running there, the binding
does not list it while sharing is off, or V1 does not list it or holds it for
another V1 thread.

Routes for a chat's grant or the owner, under `/api/v2/conversations/{id}/`:

- `GET desktops/{slug}/reservation[?candidates=a,b]`: the desk as this chat
  sees it. It has the `verdict` for its next acquire (`allowed`, `desk_busy`,
  `desk_handed_to_owner`), `holder`, `reservation`, `owner_viewer`, and
  `free_desks` when refused or when `candidates` is given.
- `POST desktops/{slug}/reservation {"op":"reserve"|"handoff"|"handback"|"unreserve", "minutes"?, "until_ms"?}`.
- `GET desktop-reservations`: every reservation of the owner that still
  holds, by chat name.

Owner only:

- `DELETE /api/v2/desktops/{slug}/reservation` frees a desk: the chat's claim
  (task or handoff) ends; the owner's own viewing stays.
- `DELETE /api/v2/desktops/{slug}/viewing` ends the owner's viewing window and
  revokes the V1 link it recorded (`link_revoked`).
- On Virtual Desks they are "Free desk" and "End viewing".
- `GET /api/v2/desktops` adds `reservation` and `owner_viewer` (with the
  holding conversation's id) to each desk, so a desk a chat keeps between
  steps never reads as available. Stop on such a desk needs the interruption
  confirmed.
- The owner's Link and Open answers carry `viewer_until_ms` and
  `viewer_recorded`. When the window could not be recorded the page warns that
  chats were not kept off the desk.

The inventory types are read tolerantly, so a Virtual Desks page loaded
before a newer server keeps working.

Migration 0104 is additive and changes no existing row. A server built before
it refuses a store that has it, because the preflight requires an exact
migration prefix. A rollback is therefore a release that keeps the migration
and reverts the checks, never an older binary on the migrated store.

Callers that take V1's lease API directly, without V2, are not covered. V1
stays the lease authority and knows nothing of reservations.

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
