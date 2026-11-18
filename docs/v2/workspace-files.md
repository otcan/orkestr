# Files panel: the chat folder

A conversation's Files panel shows, read-only, the folder its agent works in
on the host. Sections, top to bottom:

1. **Chat folder**: the folder's files and folders (folders first, then
   newest first, with size and modified time). A folder opens in place and the
   breadcrumbs lead back. A file opens a preview (text, the first 512 KiB, or
   an image) with Download (at most 25 MiB). Nothing can be written, renamed
   or deleted.
2. **In this chat**: the files the owner attached and the files the assistant
   sent, newest first (unchanged).
3. **More**, collapsed: *Your folder* (a folder on the owner's computer that the
   chat may use while the tab is open) and *Private copies*. A connected
   folder opens "More" so its state and Disconnect stay where the composer chip
   leads.

## Which folder

The operator's runtime plan (`beta.json`) decides where a conversation's
Deep session works: its pinned folder in `conversation_workspaces`, otherwise
the provider's default workspace (`workspace`, or `claude.workspace` for a
Claude conversation). Every conversation without a pinned folder shares that
default, so the panel labels it **Shared default workspace** and says that
files of other chats appear there too. It never presents the shared folder as
the chat's own.

## Who reads it

Core is the web-facing process and never opens project folders; on a
split-identity host it has no access to them at all. A small reader,
`v2/tools/workspace_reader.py`, runs as the folders' owner (the executor
account) and answers Core over a Unix socket that only Core can use. All
confinement is enforced in the reader:

- Core sends a conversation id, its provider and a relative path, never a
  folder. The reader resolves the folder from the plan, re-read when the plan
  file changes.
- A path is relative, with no empty, `.` or `..` part and no control
  character. Every part is opened from the folder's descriptor with
  `O_NOFOLLOW`, so a part replaced by a symlink during a request is refused.
  A symlink is followed only when its real path stays inside the folder.
  Devices and FIFOs are never opened.
- Protected names are never listed, opened or followed, at any depth: `.ssh`,
  `.gnupg`, `.codex`, `.claude`, `.aws`, `.docker`, `.kube`, `.netrc`,
  `.npmrc`, `.git-credentials`, `auth.json`, `.env` and `*.env`/`.env.*`,
  private keys (`id_rsa*`, `*.pem`, `*.key`, ...), and names that mention
  credentials, secrets, passwords or tokens. The listing says how many items
  it hid. This hides secret-shaped files; it does not stop an agent that
  deliberately copies a secret under another name.
- Only a peer whose `SO_PEERCRED` uid is named (`--peer-user`) gets an answer;
  the socket itself is owned by Core's account with mode 0600.

Core repeats the cheap checks (relative path, no traversal, protected names)
before it asks, drops any protected name a reader still reports, and serves
files with `Content-Security-Policy: default-src 'none'; sandbox`,
`X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
Only raster images (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF) are ever shown
inline; everything else is an attachment download. SVG is shown as text.

## HTTP

All routes need the owner's password-signed-in browser session (a machine
token or a service session is refused), and the conversation must be the
owner's.

- `GET /api/v2/conversations/{id}/workspace?path=` lists one folder:
  `{state, root_kind, root_name, path, entries, hidden, truncated}`.
  `state` is `ready`, `not_configured` (no reader on this host), `unavailable`
  or `missing` (the folder does not exist yet).
- `GET /api/v2/conversations/{id}/workspace/preview?path=` previews one file:
  `{name, size, modified_ms, downloadable, preview}` with `preview.kind`
  `text`, `image`, `binary` or `too_large`.
- `GET /api/v2/conversations/{id}/workspace/file?path=[&inline=true]` serves
  the bytes: an attachment, or an image inline.

Refusals have fixed codes: `workspace_path_outside`, `workspace_path_invalid`,
`workspace_protected`, `workspace_not_found`, `workspace_not_a_folder`,
`workspace_not_a_file`, `workspace_file_too_large` (413),
`workspace_not_an_image`, `workspace_not_configured`, `workspace_unavailable`.
`/api/v2/health` lists the feature `workspace_files_v1`.

## Running the reader

Core connects to `/run/orkestr-workspace-reader/reader.sock`, or to the socket
named by `ORKESTR_V2_WORKSPACE_READER_SOCKET`. Without a socket there the
panel says this host cannot show the folder. A systemd pair, with your own
account names:

```ini
# workspace-reader.socket
[Socket]
ListenStream=/run/orkestr-workspace-reader/reader.sock
SocketUser=<core account>
SocketMode=0600

# workspace-reader.service
[Service]
User=<workspace owner>
ExecStart=/usr/bin/python3 -I -S -B /usr/local/libexec/workspace_reader.py serve \
  --plan <path to beta.json> --peer-user <core account>
Environment=PYTHONDONTWRITEBYTECODE=1
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX
```

`workspace_reader.py check --plan <path>` validates a plan without serving.
