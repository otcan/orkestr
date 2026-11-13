# Local folder relay (ORK-750, proof of concept)

A thread can work on files of a folder on the owner's own computer, from a
machine without admin rights, through the Orkestr web app in Chrome or Edge.
The owner grants one folder to one conversation in the browser. While that
tab stays open on the conversation, the thread can list the folder, read and
hash files, package a selection, and write files. Writes apply on their own
(ORK-810): the owner allowed changes once, when he connected the folder, and
sees every write in the chat's Folder activity. Nothing outside the granted
folder can be named.

Nothing is enabled by this change alone: no thread can use it until the
operator provisions the conversation's grant and gives its Deep agent the
tool, and the owner connects a folder.

## How it works

The agent runs on the server; only the owner's open browser tab can touch
local files. The server is a small, explicit relay between the two:

```
Deep turn ── local_files.py ──► POST /local-files/requests ─┐   (grant header)
                                                            ▼
                                         local_file_requests (Core SQLite)
                                                            ▲
owner's tab ── poll every 2 s ─► POST /local-files/poll ────┘   (browser session + CSRF)
   │  performs the request inside the granted FileSystemDirectoryHandle
   ├─ list / hash ───────────► POST .../result (JSON: names, sizes, SHA-256)
   ├─ read / package ────────► encrypted upload + .../attachment, then .../result {upload_id}
   └─ write ── applied at once, one at a time in queue order ──────► .../result {bytes, SHA-256}
```

1. The thread queues a request for its own conversation. The conversation
   comes from the grant; a request never names one.
2. The owner's tab, while open and connected, polls. Each poll is the tab's
   heartbeat and hands it the oldest queued requests, so that it holds at
   most 8 at once; the rest wait queued on the server. The tab polls again
   as soon as one finishes.
3. The tab performs the request with the File System Access API on the
   folder handle the owner picked (`showDirectoryPicker`), resolving each
   name with `getDirectoryHandle`/`getFileHandle`. It posts the result.
4. File bytes never travel in the result JSON. A read or a package is
   uploaded with the existing encrypted upload client (age-encrypted chunks,
   see [encrypted browser uploads](encrypted-browser-uploads.md)) and
   prepared for the assistant like a composer attachment. The result names
   that upload; the server checks the upload itself (this owner and
   conversation, completed, prepared, the requested file name) and returns
   the prepared file's path, size and SHA-256 to the agent.
5. A write carries its content in the request (base64, at most 1 MiB). The
   tab fetches it, checks its size and SHA-256 against the request, and
   writes exactly those bytes (`createWritable`), one write at a time in the
   order the server queued them. There is no card and no browser prompt:
   read-write access was granted at **Connect folder…**
   (`showDirectoryPicker({mode: "readwrite"})`, or `requestPermission` in
   the **Reconnect** click). If the browser has taken it back, the write
   fails as `permission_denied` without asking. The server only accepts a
   write result whose size and SHA-256 equal the queued content.

## Authority and safety

- **Agent side.** A per-conversation local-files grant, the same design as
  the agent-timer grant: shown once, stored as a hash, rotated by a new
  issue, revoked at once. It is separate from thread-ask and timer grants.
  The operator may issue it with the owner's dedicated service credential
  (as for agent-timer grants); a revoked or expired credential cannot.
  It is sent as `x-orkestr-local-files-grant` with no cookie, bearer or
  Origin, and only works while the conversation has a dispatched Deep run,
  which every request is pinned to. Fast never gets the tool.
- **Tab side.** Only an interactive browser session of the owner
  (`auth_sessions.kind = 'browser'`): never a machine bearer and never a
  service credential. Every write route needs the browser CSRF token
  (enforced by the server's browser guard).
- **No folder, clear answer.** Without a connected tab a new request is
  refused with `409 local_files_not_connected`; the tool exits 5 and tells
  the agent what to ask the owner.
- **Inside the folder only.** Paths are relative, `/`-separated names,
  never empty, `.` or `..`, no leading or trailing `/`, no backslash or
  control character, at most 32 levels and 1024 bytes. The server, the tool
  and the tab each refuse anything else; the tab also refuses it if a server
  were to send one (`invalid_path`). There is no API that can name a file
  outside the handle.
- **Read and write, granted once (ORK-810).** Connect asks the browser, in
  that click, to let the site view and change the folder. A browser that
  grants viewing only leaves the folder read-only: the Files panel says so,
  writes fail as `permission_denied`, and **Allow changes** asks again in a
  click. The tab never asks for permission outside a click.
- **Deadlines.** Every request has one (default 2 minutes, 5 s to 10 minutes).
  Unfinished requests fail as `expired` after it, and as
  `local_files_disconnected` when the tab disconnects or has not polled for
  75 s. These transitions are written before any read returns them, so a
  request the agent was told failed is never performed later.
- **One tab.** One tab serves a conversation's folder. Another tab replaces
  it only when the owner chooses it there (**Use this tab**); requests the old
  tab held are offered to the new one.
- **Visible.** While connected, the composer's folder chip shows "● name"
  and the browser tab title starts with "● ". The chip links to the chat's
  **Files** panel (ORK-809), whose **Your folder** section holds the state in
  words, Disconnect and **Folder activity**.
  Disconnecting (or leaving the conversation) stops serving the folder at
  once and fails what is still open.
- **No approval step (ORK-810).** Before ORK-810 each write waited for the
  owner's **Allow write** in the tab serving the folder, and every tab read
  `GET /api/v2/local-files/waiting` to say so (ORK-804). Writes now apply on
  their own. The route and its health feature stay for UI releases before
  ORK-810 (a tab still open on one shows Allow cards); the current UI never
  reads it, and it reports at most 8 writes per chat, the bound those
  releases accept.
- **Logged.** Every request stays in `local_file_requests` (operation,
  paths, run, grant generation, times, outcome, result). Write content is
  cleared once the request is finished; its size and SHA-256 stay. The tab
  lists the 20 most recent requests under **Folder activity** in the chat's
  Files panel, with time and, for a write, its size: `written`, or `not
  written: <code>`. One it no longer holds before it answered (expired,
  revoked or finished elsewhere) stays listed: `expired, nothing written`
  for a write, `expired` otherwise.
- **Caps.** At most 64 unfinished requests per conversation (the tab works
  on 8 at a time, the rest wait queued) and 120 per 10 minutes; past either
  a new request gets `429 local_files_rate_limited`, and the agent tool waits
  and asks again with the same key within its timeout. Before ORK-810 the
  cap was 8 unfinished requests, so a batch of 10 writes lost 2.

## API

| Route | Caller | Effect |
|---|---|---|
| `GET\|PUT\|DELETE /api/v2/conversations/{id}/local-files-grant` | owner (browser + CSRF, machine bearer, or the owner's live service credential) | read, issue/rotate (shown once), revoke the grant; revoking fails open requests |
| `POST .../local-files/requests` | grant holder | queue `{"request_key","operation","path"?,"paths"?,"content_base64"?,"timeout_ms"?}`; 202, or 200 for a replay of the key |
| `GET .../local-files/requests/{request}` | grant holder | state (`queued`, `working`, `done`, `failed`), error, result, `status_text` |
| `POST .../local-files/poll` | owner's tab | `{"connection_id","folder_name","takeover"?}`: heartbeat, returns the requests this tab holds |
| `GET .../local-files/requests/{request}/content?connection_id=` | owner's tab | the bytes of a write this tab holds |
| `POST .../local-files/requests/{request}/result` | owner's tab | `{"connection_id","outcome":"done"\|"failed","error"?, "listing"\|"hashes"\|"written"\|"upload_id"\|"empty"}` |
| `POST .../local-files/disconnect` | owner's tab | this tab stops serving the folder |
| `GET .../local-files?limit=N` | owner's tab | grant state, connection, newest requests |
| `GET /api/v2/local-files/waiting` | owner (browser, machine bearer, or the owner's live service credential) | kept for UI releases before ORK-810: conversations with an unfinished, unexpired write while its folder tab is connected, `writes` capped at 8: `{"conversations":[{"conversation_id","conversation_name","folder_name","writes","deadline_ms"}]}` |

Operations: `list` (one directory, not recursive, at most 1000 entries),
`read` (one file), `hash` (1 to 64 files, SHA-256 computed in the browser),
`write` (create or replace one file in an existing folder), `package` (an
uncompressed ustar archive `selection-<id>.tar` of 1 to 64 files).
Tab error codes: `not_found`, `not_a_file`, `not_a_directory`, `too_large`,
`refused_by_owner` (only from UI releases before ORK-810),
`permission_denied`, `invalid_path`, `changed`, `browser_error`. The server
advertises `local_files_v1` and `local_file_writes_waiting_v1` in
`/api/v2/health`. The UI release requires `local_files_v1`; since ORK-810 it
no longer requires the waiting list, which stays for older UI releases.

## Limits

| Limit | Value |
|---|---|
| Read (one file) | 64 MiB |
| Package (whole archive) | 64 MiB |
| Hash (one file, hashed in browser memory) | 128 MiB |
| Write content | 1 MiB |
| Files per hash or package | 64 |
| Listing | 1000 entries, one directory |
| Deadline | 2 min default, 5 s to 10 min |
| Unfinished requests per conversation | 64 queued, 8 in the tab at once |
| Connection lifetime without a poll | 75 s |

Reads and packages are ordinary encrypted uploads: they count toward the
owner's 4 GiB encrypted upload reservation and stay until they are deleted
(see [encrypted browser uploads](encrypted-browser-uploads.md)).

## Agent tool

`v2/tools/local_files.py` (same pattern as `agent_timer.py`). The grant comes
from `ORKESTR_V2_LOCAL_FILES_GRANT`, a private `--grant-file`, or
`ORKESTR_V2_LOCAL_FILES_GRANT_DIR/<conversation>.local-files.grant` (the
directory the agent grant `<conversation>.grant` shares); `ORKESTR_V2_URL`
and `ORKESTR_V2_CONVERSATION` name the server and conversation.

```sh
local_files.py list                       # the connected folder
local_files.py list docs
local_files.py read docs/plan.md          # prints local_file: <prepared file on the server>
local_files.py hash a.pdf b.pdf
local_files.py package docs/plan.md data/table.csv
local_files.py write docs/plan.md --from-file /tmp/plan.md   # applies on its own while connected
local_files.py status <request id>
local_files.py instructions               # the short agent rules
```

Exit status: 0 done, 3 not finished when the wait ended, 4 not done
(not found, no permission, expired, disconnected), 5 no folder connected, 2
refused or failed. Each call prints its request key first; after a lost
answer, rerun with `--request-key KEY` to get the same request.

`--timeout` defaults to 120 s (at most 600 s, the server maximum). A write
needs no approval (ORK-810), but a tab in the background may poll only once
a minute, so a write's timeout is never below 120 s; a shorter one is raised
with a note on stderr. While the conversation's queue is full
(`429 local_files_rate_limited`) the tool waits and asks again with the same
request key within its timeout.

The agent learns the command from the Deep house rules, or from the
generated rules of a new WhatsApp chat (`house_rules::files_rules`, with
`agent_timers.local_files_tool`, by default
`/usr/local/libexec/orkestr-local-files/local_files.py`): run it in its own
shell, never through a Root request, host.exec, sudo or another user (the
grant works only for the agent). Since ORK-810 the rules say a write applies
on its own while the folder is connected (no `--timeout 600`, no asking
before many files). Rules files written before carry the old bullet; the
private overlay has a one-off update for them.

## Enabling it for one conversation (operator)

1. Deploy a server and UI built from the same commit (the migration
   `0098_local_files.sql` is additive).
2. With `agent_timers` configured (see [agent timers](agent-timers.md)) the
   server issues every conversation's local-files grant itself, beside its
   agent grant: at creation and after each admitted input, and again when the
   installed file is missing or no longer the current grant (ORK-804). A
   revoked grant stays revoked. Nothing else is needed.
3. Without it, provision the grant by hand:
   `local_files_provision.py --v2-url URL --credentials FILE --grant-dir DIR
   --conversation <uuid> --chown <deep agent user>` (`--revoke` to remove).
   It installs `DIR/<conversation>.local-files.grant`, so it may share the
   agent-timer grant directory. DIR must be the directory the agent sees:
   with a broker that projects a Core-written grant directory into the
   agent's namespace, install into that source directory, never at the
   projection's target path on the host (a file there is hidden from every
   agent, and the issue still rotates the grant).
4. Give that conversation's Deep agent the tool:
   `ORKESTR_V2_LOCAL_FILES_GRANT_DIR=DIR`, `ORKESTR_V2_URL`,
   `ORKESTR_V2_CONVERSATION`, and the text of `local_files.py instructions`
   in its chat rules. Never for Fast.

## Demo (owner, Chrome, after deploy)

1. On the computer with the files, open **app.orkestr.de** in Chrome (or Edge)
   and open the conversation the operator enabled.
2. Make a test folder, for example `orkestr-demo` with `notes.txt` ("hello")
   and a subfolder `docs` with one or two files.
3. In the composer press **Connect folder…** and pick `orkestr-demo`.
   Chrome asks once to let the site view and edit files: allow it. The chip
   now shows "● orkestr-demo" and the tab title starts with "●".
4. Write in the chat: "List my local folder." The thread answers with
   `notes.txt` and `docs`.
5. "Read notes.txt and tell me its SHA-256." The thread reads the file (it
   arrives through the encrypted upload) and gives the checksum. Compare
   with `sha256sum notes.txt` (or `Get-FileHash notes.txt` on Windows).
6. "Package notes.txt and everything in docs." The thread gets one
   `selection-….tar`.
7. "Append a line 'checked by Orkestr' to notes.txt." Nothing asks you: the
   thread reports "Wrote", and `notes.txt` on disk has the line. Press the
   chip: **Files** lists it under **Folder activity** (`write notes.txt (…
   bytes): written`). "Create ten small files in docs": all ten are written,
   in order.
8. "Read ../something" or any path outside the folder: refused.
9. Press the "● orkestr-demo" chip (it opens **Files**), then **Disconnect
   folder**. Ask "List my local folder" again: the thread
   says no folder is connected and asks you to connect one.

## Limitations

- **Browsers.** Needs the File System Access directory picker: Chrome or
  Edge (version 86 or later) on Windows, macOS, Linux or ChromeOS. Firefox,
  Safari and mobile browsers do not have it; the control then says so.
  Chrome refuses to grant some system folders (for example the whole home
  folder or system directories); pick a subfolder.
- **The tab must stay open on that conversation.** Leaving the conversation
  disconnects the folder at once; closing or reloading the tab disconnects it
  at the latest 75 s later (requests then fail as `local_files_disconnected`).
  After a reload, **Reconnect “name”** connects it again with one click (Chrome
  may ask for the permission again). Chrome may wake a hidden tab only once a
  minute, so requests can wait up to a minute when the tab is in the
  background; the 75 s connection lifetime allows for that.
- **POC scope.** No recursive listing, no folder creation, delete or rename,
  one tab per conversation, no streaming hash (files are hashed in memory,
  hence the 128 MiB cap), sizes as in the table above.
- **Symbolic links** inside the folder are resolved by the browser's own
  rules; this was not tested against a real Chrome.
- **Uploads stay.** Read and packaged files remain encrypted uploads of the
  conversation until deleted and count toward the owner's upload budget.

## Tests

- Store: `production_runtime::local_files::tests` (grant, running-turn and
  browser-only authority, round trips bound to their request, deadlines,
  disconnects and takeover settled before any read, path and size caps, a
  batch of writes queued and handed out 8 at a time in order) and
  `production_runtime::local_files::waiting::tests` (only open, unexpired
  writes with a live tab; read-only; capped at 8 for older UIs).
- Server: `local_files_http::tests` (grant header only, CSRF and browser
  session, 1 MiB write route limit, unprepared uploads refused),
  `local_files_waiting_http::tests` and
  `note_sha256_reads_the_materialized_receipt_format`.
- Browser worker: `v2/apps/ui/src/local_files/*.test.mjs` with the synthetic
  directory handle `v2/ci/local-files-fake-directory.mjs`.
- Headless: `v2/ci/headless-local-files.mjs` runs the real UI bundle against
  the synthetic API (`headless-local-files-mock.mjs`). Chromium in CI cannot
  show a picker, so the test replaces `window.showDirectoryPicker` before the
  page loads; the UI bundle contains no test hook, which the test checks.
  It checks that Connect asks once for read and write, that writes (a batch
  of ten, and one while the tab is hidden) apply with no card, prompt or
  title mark, in queue order, and that written, rejected and expired writes
  are listed in Folder activity.
- Agent tool: `v2/tools/tests/test_local_files.py`.
