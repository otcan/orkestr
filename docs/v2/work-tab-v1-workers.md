# Work tab: V1 workers of a linked chat

A conversation that is linked to a V1 thread (imported from it, provisioned
by "New WhatsApp chat", or delegated to V2 from a V1 WhatsApp binding) can
still get V1 *worker sub-threads*: an external coordinator creates them with
`orkestr worker create <v1 thread> --task …`. The conversation's **Work** tab
lists them in a "V1 workers" section, next to the Deep run and the V2
workers. Listing a worker never starts, wakes or steers it.

## Route

`GET /api/v2/conversations/{id}/v1-workers` (owner Bearer or browser
cookie, like the other conversation routes; `Cache-Control: no-store`).

- **Linked thread.** The conversation's V1 link in the sidebar's precedence:
  durable lineage, the first archived history source, then the provisioned
  WhatsApp thread (one light store read, no previews or activity); else the
  V1 thread whose binding delegates its runtime to this conversation
  (`remoteThreadId`, read from the cached registry). A conversation without a
  link answers `v1_thread_id: null` and no workers; the
  UI hides the section.
- **Workers.** Threads of the cached V1 registry the sidebar uses (15 s
  freshness, stale copy up to 2 minutes) whose parent is the linked thread or
  one of its workers, up to 8 levels deep. The parent is V1
  `parentThreadId`, else the parent a `worker-<parent>-<suffix>` id encodes
  when that parent exists. Task agents are not listed; cycles are cut.
- **Fields.** `name` (at most 120 characters), `state` (`working`, `idle`,
  `retired`), `last_activity_ms`, `depth`, `parent_thread_id`, `preview` (only
  when the sidebar already cached one: this route never reads V1 messages),
  `openable` (the sidebar lists the thread, so `#v1/<thread>` opens it) and
  `conversation_id` (the worker was itself imported into a V2 conversation).
- **Bounds.** At most 32 workers: active ones newest first, then retired
  ones, so a cut drops retired workers first (`truncated`). `retired` counts
  every retired worker found.
- **V1 state.** `v1_status` is `unconfigured` without the private V1 client
  and `unavailable` when V1 does not answer; the list is then empty.

## UI

The Work tab polls the route on its status cadence (the shared read-only
status channel, every 2 s while the tab is open). Each worker shows its
name, state, last activity and the cached preview. The name links to the
worker's V2 conversation, or to its linked V1 entry the way the sidebar opens
V1 chats; a worker the sidebar does not list (retired, or found only by its
encoded id) is shown without a link. Retired workers are hidden behind a
"Show retired (n)" toggle. With no workers to show, the section says
"No V1 workers".
