# Local folder relay (ORK-750, proof of concept)

A thread can work on files of a folder on the owner's own computer, from a
machine without admin rights, through the Orkestr web app in Chrome or Edge.
The owner grants one folder to one conversation in the browser. While that
tab stays open on the conversation, the thread can list the folder, read and
hash files, package a selection, and write a change after the owner allows
it. Nothing outside the granted folder can be named.

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
   └─ write ── owner clicks Allow (browser asks for write access) ──► .../result {bytes, SHA-256}
```

1. The thread queues a request for its own conversation. The conversation
   comes from the grant; a request never names one.
2. The owner's tab, while open and connected, polls. Each poll is the tab's
   heartbeat and hands it every queued request of the conversation.
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
   tab shows the owner the path, size and a text preview. Only after the
   owner presses **Allow write** does the browser ask for write permission
   (`requestPermission({mode: "readwrite"})` in that click), and the tab
   writes exactly the queued bytes (`createWritable`). The server only
   accepts a write result whose size and SHA-256 equal the queued content.

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
- **Read-only by default.** The picker asks for read access only. Write
  access is asked for by the browser in the owner's Allow click, and every
  write needs its own Allow. Refuse is reported as `refused_by_owner`.
- **Deadlines.** Every request has one (default 2 minutes, 5 s to 10 minutes).
  Unfinished requests fail as `expired` after it, and as
  `local_files_disconnected` when the tab disconnects or has not polled for
  75 s. These transitions are written before any read returns them, so a
  request the agent was told failed is never performed later.
- **One tab.** One tab serves a conversation's folder. Another tab replaces
  it only when the owner chooses it there (**Use this tab**); requests the old
  tab held are offered to the new one.
- **Visible.** While connected, the conversation toolbar shows
  "● Folder “name” connected" and the browser tab title starts with "● ".
  Disconnecting (or leaving the conversation) stops serving the folder at
  once and fails what is still open.
- **A waiting write is seen everywhere (ORK-804).** A write is answered only
  in the tab serving the folder. While one waits there, that tab's title
  starts with "Approve write · " (also when the tab is hidden), and if the
  owner already allowed notifications for the site, one system notification
  is shown per write (permission is never asked for). Every other tab of the
  app, on any device, reads `GET /api/v2/local-files/waiting`: its title gets
  the same mark, a notice under the header names the chat and says to allow
  or refuse the write in the browser tab where that folder is connected, and
  the chat's list row shows **Approve write**.
- **Logged.** Every request stays in `local_file_requests` (operation,
  paths, run, grant generation, times, outcome, result). Write content is
  cleared once the request is finished; its size and SHA-256 stay. The tab
  shows the recent requests under **Folder activity**, including one it no
  longer holds before it answered (expired, revoked or finished elsewhere):
  `expired, nothing written` for a write, `expired` otherwise.
- **Caps.** At most 8 unfinished requests per conversation and 120 per 10
  minutes (`429 local_files_rate_limited`).

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
| `GET /api/v2/local-files/waiting` | owner (browser, machine bearer, or the owner's live service credential) | conversations with an unfinished, unexpired write waiting for the owner while its folder tab is connected: `{"conversations":[{"conversation_id","conversation_name","folder_name","writes","deadline_ms"}]}` |

Operations: `list` (one directory, not recursive, at most 1000 entries),
`read` (one file), `hash` (1 to 64 files, SHA-256 computed in the browser),
`write` (create or replace one file in an existing folder), `package` (an
uncompressed ustar archive `selection-<id>.tar` of 1 to 64 files).
Tab error codes: `not_found`, `not_a_file`, `not_a_directory`, `too_large`,
`refused_by_owner`, `permission_denied`, `invalid_path`, `changed`,
`browser_error`. The server advertises `local_files_v1` and
`local_file_writes_waiting_v1` in `/api/v2/health`, and the UI release
requires both. The waiting list accepts fields a newer server adds, so an
older UI keeps working; the sidebar page is unchanged.

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
| Connection lifetime without a poll | 75 s |

Reads and packages are ordinary encrypted uploads: they count toward the
owner's 4 GiB encrypted upload reservation and stay until they are deleted
(see [encrypted browser uploads](encrypted-browser-uploads.md)).

## Agent tool

`v2/tools/local_files.py` (same pattern as `agent_timer.py`). The grant comes
from `ORKESTR_V2_LOCAL_FILES_GRANT`, a private `--grant-file`, or
`ORKESTR_V2_LOCAL_FILES_GRANT_DIR/<conversation>.grant`; `ORKESTR_V2_URL`
and `ORKESTR_V2_CONVERSATION` name the server and conversation.

```sh
local_files.py list                       # the connected folder
local_files.py list docs
local_files.py read docs/plan.md          # prints local_file: <prepared file on the server>
local_files.py hash a.pdf b.pdf
local_files.py package docs/plan.md data/table.csv
local_files.py write docs/plan.md --from-file /tmp/plan.md   # waits for the owner's Allow
local_files.py status <request id>
local_files.py instructions               # the short agent rules
```

Exit status: 0 done, 3 not finished when the wait ended, 4 not done
(refused, not found, expired, disconnected), 5 no folder connected, 2
refused or failed. Each call prints its request key first; after a lost
answer, rerun with `--request-key KEY` to get the same request.

## Enabling it for one conversation (operator)

1. Deploy a server and UI built from the same commit (the migration
   `0098_local_files.sql` is additive).
2. Provision the grant, like the timer grant, in its own directory:
   `local_files_provision.py --v2-url URL --credentials FILE --grant-dir DIR
   --conversation <uuid> --chown <deep agent user>` (`--revoke` to remove).
   If the Deep agent can only read the agent-timer grant directory, install
   the grant there as `<conversation>.local-files.grant` and pass that file
   with `--grant-file`. Never run the provisioning tool with `--grant-dir` on
   that directory: it writes `<conversation>.grant`, the timer grant's name.
3. Give that conversation's Deep agent the tool:
   `ORKESTR_V2_LOCAL_FILES_GRANT_DIR=DIR`, `ORKESTR_V2_URL`,
   `ORKESTR_V2_CONVERSATION`, and the text of `local_files.py instructions`
   in its chat rules. Never for Fast.

## Demo (owner, Chrome, after deploy)

1. On the computer with the files, open **app.orkestr.de** in Chrome (or Edge)
   and open the conversation the operator enabled.
2. Make a test folder, for example `orkestr-demo` with `notes.txt` ("hello")
   and a subfolder `docs` with one or two files.
3. In the conversation toolbar press **Connect folder…** and pick
   `orkestr-demo`. Chrome asks to let the site view files: allow it. The
   toolbar now shows "● Folder “orkestr-demo” connected" and the tab title
   starts with "●".
4. Write in the chat: "List my local folder." The thread answers with
   `notes.txt` and `docs`.
5. "Read notes.txt and tell me its SHA-256." The thread reads the file (it
   arrives through the encrypted upload) and gives the checksum. Compare
   with `sha256sum notes.txt` (or `Get-FileHash notes.txt` on Windows).
6. "Package notes.txt and everything in docs." The thread gets one
   `selection-….tar`.
7. "Append a line 'checked by Orkestr' to notes.txt." A yellow box shows the
   path, size and new text. Press **Allow write**; Chrome asks to let the
   site save changes: allow it. Open `notes.txt` on disk: it has the line.
   Ask for another change and press **Refuse**: the thread reports that you
   refused it and the file is unchanged.
8. "Read ../something" or any path outside the folder: refused.
9. Press **Disconnect folder**. Ask "List my local folder" again: the thread
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
  disconnects and takeover settled before any read, path and size caps) and
  `production_runtime::local_files::waiting::tests` (only open, unexpired
  writes with a live tab; read-only).
- Server: `local_files_http::tests` (grant header only, CSRF and browser
  session, 1 MiB write route limit, unprepared uploads refused),
  `local_files_waiting_http::tests` and
  `note_sha256_reads_the_materialized_receipt_format`.
- UI: `v2/apps/ui/tests/local_writes.rs` (notice and row texts).
- Browser worker: `v2/apps/ui/src/local_files/*.test.mjs` with the synthetic
  directory handle `v2/ci/local-files-fake-directory.mjs`.
- Headless: `v2/ci/headless-local-files.mjs` runs the real UI bundle against
  the synthetic API (`headless-local-files-mock.mjs`). Chromium in CI cannot
  show a picker, so the test replaces `window.showDirectoryPicker` before the
  page loads; the UI bundle contains no test hook, which the test checks.
  It also checks that a write queued while the folder tab is hidden marks
  its title and every other tab (title, notice, list row), and that an
  expired write closes its card and shows `expired, nothing written`.
- Agent tool: `v2/tools/tests/test_local_files.py`.
