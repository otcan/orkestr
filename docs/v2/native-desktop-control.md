# Native controls for an assigned desktop

The desktop lease client discovers and reserves desks. A CDP inspector reads
web-page state. Chrome's own menus and saved-login suggestions require native
desktop input. `v2/tools/desktop_control.py` supplies that input through the
existing authenticated host-command integration; it also writes private PNGs
which the conversation's agent can open with its image viewer.

Install the reviewed controller and `desktop_framebuffer.py` together in a
Root-owned directory. Invoke Python with `-I -S -B` and
`PYTHONDONTWRITEBYTECODE=1`. A protected operator configuration selects exactly
one conversation and one existing managed desktop. Configuration contains file
references, not credentials:

```json
{
  "format": "orkestr-desktop-control-v1",
  "v2_url": "http://127.0.0.1:19822",
  "conversation_id": "11111111-1111-4111-8111-111111111111",
  "v1_thread_id": "22222222-2222-4222-8222-222222222222",
  "desktop_slug": "example-desk",
  "grant_file": "/etc/orkestr/example-desktop-grant.env",
  "broker_file": "/var/lib/example-core/desktop-broker.json",
  "broker_uid": 1001,
  "framebuffer_port": 15900,
  "framebuffer_unit": "example-x11vnc.service",
  "state_directory": "/var/lib/orkestr-desktop-control/example",
  "output_directory": "/var/lib/orkestr-desktop-control/images",
  "output_uid": 1002,
  "output_gid": 1002
}
```

The grant file contains the existing `ORKESTR_V2_DESKTOP_GRANT` assignment.
The broker file is the existing service-private V1 broker configuration.
The state directory must be private to Root. The output directory stays owned
by Root and is traversable by the selected executor; each new screenshot is
mode 0600 and owned by the configured executor. Do not expose screenshots in
public logs, source control or shared artifacts. Remove them after use.

Call the controller through the conversation's authenticated host tool, with
a fresh UUID request ID for each intended action:

```json
{
  "program": "host",
  "argv": [
    "/usr/bin/python3", "-I", "-S", "-B",
    "/usr/local/libexec/orkestr-desktop-control/desktop_control.py",
    "--configuration", "/etc/orkestr-desktop-control/example.json",
    "--request-id", "33333333-3333-4333-8333-333333333333",
    "start"
  ],
  "cwd": "/",
  "timeout_s": 90
}
```

Read the actual host result. `start` returns a `session_id`, private
`screenshot_path`, dimensions, and screenshot checksum. Open the PNG before
choosing coordinates. Subsequent calls include `--session-id <session_id>`:

| Operation | Positional values |
| --- | --- |
| `screenshot` | None |
| `move` | x y |
| `click` | x y button (1–5) |
| `key` | One supported X11 key name, such as `Tab`, `Down`, `Return`, `Escape` |
| `type` | One bounded, visible, nonsecret text string |
| `release` | None |

Select saved sign-ins through Chrome's visible UI. Never pass passwords as
typed text, reveal password fields, or read Chrome's credential/profile files.
Desktop control does not add authorization for external submissions, messages
or uploads. Keep the original task's approvals and limits.

Every new action checks the current conversation binding, V1 acquire/operate
permissions, and V2 lease. The framebuffer must belong to the configured
active service in the host network namespace. A session pins its process and
listener identity; a restarted target requires a new session. Stateful input
does not silently retarget a restarted desk. The connection is shared and
does not disconnect an owner's viewer. Always release when finished.

Request IDs prevent duplicate input. An identical completed request returns
its stored result without another click. A recorded intent without a result
has an uncertain outcome: do not retry it under a new ID. Use `status` with
the original `--request-id` to inspect the safe receipt, reconcile the visible
state, and release the recorded session. The fencing token stays private.
There is no automatic retry or automatic deletion of active control state.
