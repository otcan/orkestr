#!/usr/bin/env python3
"""Attach files of THIS chat's workspace to the reply a running Deep turn is writing (ORK-779).

  reply_attach.py --v2-url URL --conversation ID --workspace DIR attach FILE [FILE ...] [--request-key KEY]
  reply_attach.py --workspace DIR check FILE [FILE ...]
  reply_attach.py instructions [--v2-url URL --conversation ID --workspace DIR --grant-dir DIR]

`attach` stores the files in this conversation's attachment store and prints
one marker line per file on stdout. End the reply with those lines, unchanged,
each on its own line: the web chat shows each as an attachment card, and the
WhatsApp adapter sends the files with the reply to this chat's own group (as a
document, or as an image for PNG/JPEG/WebP). `check` validates only and sends
nothing.

* FILE is a path inside --workspace (relative to it, or absolute under it).
  `..`, hidden names, and symbolic links anywhere in the path are refused, as
  are secret-looking folders (.ssh, secrets, credentials, vault, tokens ...).
* Types: pdf, docx, xlsx, xls, pptx, csv, txt, md, png, jpg/jpeg, webp, zip
  (what WhatsApp is sent); 1 byte to 16 MiB in all, at most 8 files per reply.
* Idempotent: the request key comes from the conversation and the files'
  names and contents, so a retry stores nothing new and prints the same lines.
  After a failure, rerun the same command (or pass the printed --request-key).
* Only while a Deep turn of this conversation runs; never from Fast.

The grant is the conversation's agent grant (the agent timer grant): from
--grant-file, ORKESTR_V2_AGENT_TIMER_GRANT, or
ORKESTR_V2_AGENT_TIMER_GRANT_DIR/<conversation>.grant. It is never printed.
Exit status: 0 done, 2 refused or failed (one JSON line on stderr).
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib import error, parse, request
import uuid

GRANT_HEADER = 'X-Orkestr-Agent-Timer-Grant'
ERROR_EXIT = 2
MAX_BYTES = 16 * 1024 * 1024
MAX_FILES = 8
# Exactly the types the WhatsApp worker sends (whatsapp-scoped-reply-files.js).
TYPES = {
    'pdf': 'application/pdf',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xls': 'application/vnd.ms-excel',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'csv': 'text/csv', 'txt': 'text/plain', 'md': 'text/markdown',
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'webp': 'image/webp',
    'zip': 'application/zip',
}
SECRET_PARTS = re.compile(r'^(?:secrets?|credentials?|vault|cookies?|tokens?|private[-_]?keys?)$', re.I)
MARKER = re.compile(r'^\[orkestr-attachment manifest=[0-9a-f-]{36} reference=[0-9a-f-]{36}(?: [^\]\n]*)?\]$')


class AttachError(RuntimeError):
    def __init__(self, status, code, **extra):
        super().__init__(f'{status}:{code}')
        self.status, self.code, self.extra = status, code, extra


RULES = """Files for the owner (reply attachment tool)

When the owner should receive a file you made or found in this chat's
workspace (PDF, Word, Excel, PowerPoint, CSV, text, Markdown, PNG, JPEG, WebP
or ZIP), attach it to your reply with the command below. Never answer with a
Markdown link or a path to a workspace file instead: the owner can open
neither, on WhatsApp or in the web app.

```bash
(
  set -e
  set -- attach "<path inside the workspace>"   # several files: list them all
  ORKESTR_V2_AGENT_TIMER_GRANT_DIR={grant_dir} \\
  PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B \\
    {tool} \\
    --v2-url {v2_url} \\
    --conversation {conversation} \\
    --workspace {workspace} \\
    "$@"
)
```

The command prints one line per file, like
`[orkestr-attachment manifest=... reference=... name="report.pdf"]`.
End your reply with exactly those lines, unchanged, each on its own line
(not in a code block, not translated). The web chat shows them as attachment
cards and WhatsApp receives the files with your reply, in this chat only.
Mention the files by name in your text; do not add their paths.

Only files inside the workspace (no `..`, hidden or secret folders, or
symbolic links), at most 8 files and 16 MiB per reply, and only while this
Deep turn runs. If it refuses, tell the owner the code in one line instead of
retrying in a loop. A retry of the same command never stores a file twice.
"""


def grant_path(conversation, environ=os.environ):
    root = environ.get('ORKESTR_V2_AGENT_TIMER_GRANT_DIR', '').strip()
    return Path(root) / f'{conversation}.grant' if root else None


def read_grant(path=None, environ=os.environ):
    if path:
        path = Path(path)
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise AttachError(0, 'grant_file_must_be_private')
            value = path.read_text().strip()
        except FileNotFoundError:
            raise AttachError(0, 'grant_file_missing') from None
        except (OSError, UnicodeError):
            raise AttachError(0, 'grant_missing_or_invalid') from None
    else:
        value = environ.get('ORKESTR_V2_AGENT_TIMER_GRANT', '').strip()
    if len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise AttachError(0, 'grant_missing_or_invalid')
    return value


def relative_parts(workspace, raw):
    """The path's components under the workspace root, or a refusal."""
    if not isinstance(raw, str) or not raw or '\0' in raw:
        raise AttachError(0, 'file_refused')
    if os.path.isabs(raw):
        for root in dict.fromkeys((workspace, os.path.realpath(workspace))):
            prefix = root.rstrip('/') + '/'
            if raw.startswith(prefix):
                raw = raw[len(prefix):]
                break
        else:
            raise AttachError(0, 'file_outside_workspace')
    parts = [p for p in raw.split('/') if p not in ('', '.')]
    if not parts or '..' in parts:
        raise AttachError(0, 'file_outside_workspace')
    for part in parts:
        if part.startswith('.') or SECRET_PARTS.match(part):
            raise AttachError(0, 'file_refused')
    return parts


def read_file(workspace, raw):
    """(name, media type, bytes) of one regular file under the workspace,
    opened component by component without following any symbolic link."""
    root = os.path.realpath(workspace)
    if not os.path.isabs(workspace) or root == '/' or not os.path.isdir(root):
        raise AttachError(0, 'workspace_invalid')
    parts = relative_parts(workspace, raw)
    name = parts[-1]
    extension = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
    media = TYPES.get(extension)
    if media is None:
        raise AttachError(0, 'file_type_unsupported', supported=sorted(TYPES))
    if any(ord(c) < 32 or ord(c) == 127 for c in name) or len(name.encode()) > 255:
        raise AttachError(0, 'file_name_refused')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            except FileNotFoundError:
                raise AttachError(0, 'file_missing') from None
            except OSError:
                # ELOOP/ENOTDIR: a symbolic link or a file where a folder must be.
                raise AttachError(0, 'file_symlink_refused') from None
            os.close(fd)
            fd = child
        try:
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
        except FileNotFoundError:
            raise AttachError(0, 'file_missing') from None
        except OSError:
            raise AttachError(0, 'file_symlink_refused') from None
    finally:
        os.close(fd)
    try:
        before = os.fstat(handle)
        if not stat.S_ISREG(before.st_mode):
            raise AttachError(0, 'file_not_regular')
        if not 0 < before.st_size <= MAX_BYTES:
            raise AttachError(0, 'file_size_refused', max_bytes=MAX_BYTES)
        chunks, size = [], 0
        while True:
            chunk = os.read(handle, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise AttachError(0, 'file_size_refused', max_bytes=MAX_BYTES)
            chunks.append(chunk)
        after = os.fstat(handle)
        if (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns) or size != before.st_size:
            raise AttachError(0, 'file_changed_while_reading')
    finally:
        os.close(handle)
    # The attachment store refuses ':' in names; WhatsApp shows the rest as is.
    return name.replace(':', '_'), media, b''.join(chunks)


def read_files(workspace, paths):
    if not workspace:
        raise AttachError(0, 'workspace_required')
    if not paths or len(paths) > MAX_FILES:
        raise AttachError(0, 'file_count_refused', max_files=MAX_FILES)
    files = [read_file(workspace, raw) for raw in paths]
    if sum(len(data) for _, _, data in files) > MAX_BYTES:
        raise AttachError(0, 'files_too_large', max_bytes=MAX_BYTES)
    return files


def default_key(conversation, files):
    """Stable for the same files, so a retried attach stores them once."""
    body = json.dumps([conversation, [[n, hashlib.sha256(d).hexdigest()] for n, _, d in files]])
    return str(uuid.UUID(bytes=hashlib.sha256(body.encode()).digest()[:16], version=4))


class Client:
    def __init__(self, base_url, conversation, grant, timeout=60):
        parsed = parse.urlsplit(base_url or '')
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise AttachError(0, 'invalid_base_url')
        try:
            if str(uuid.UUID(conversation)) != conversation:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise AttachError(0, 'invalid_conversation') from None
        self.url = f'{parsed.scheme}://{parsed.netloc}/api/v2/conversations/{conversation}/agent-attachments'
        self.grant, self.timeout = grant, timeout

    def attach(self, files, request_key):
        body = json.dumps({'request_key': request_key, 'files': [
            {'filename': n, 'media_type': m, 'content_base64': base64.b64encode(d).decode()} for n, m, d in files]}).encode()
        req = request.Request(self.url, data=body, method='POST', headers={
            'Accept': 'application/json', 'Content-Type': 'application/json', GRANT_HEADER: self.grant})
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read()
        except error.HTTPError as failure:
            try:
                code = str(json.loads(failure.read()).get('code') or 'http_error')[:64]
            except (ValueError, AttributeError):
                code = 'http_error'
            finally:
                failure.close()
            raise AttachError(failure.code, code) from None
        except (error.URLError, OSError):
            raise AttachError(0, 'unreachable') from None
        try:
            receipt = json.loads(raw)
            lines = receipt['note'].split('\n')
        except (ValueError, KeyError, TypeError, AttributeError):
            raise AttachError(0, 'receipt_invalid') from None
        if len(lines) != len(files) or not all(MARKER.match(line) for line in lines):
            raise AttachError(0, 'receipt_invalid')
        return lines


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    root.add_argument('--v2-url', default=os.environ.get('ORKESTR_V2_URL'))
    root.add_argument('--conversation', default=os.environ.get('ORKESTR_V2_CONVERSATION'))
    root.add_argument('--workspace', help="this chat's workspace root (absolute)")
    root.add_argument('--grant-file')
    commands = root.add_subparsers(dest='action', required=True)
    attach = commands.add_parser('attach')
    attach.add_argument('files', nargs='+')
    attach.add_argument('--request-key', help='reuse the key a failed or unanswered call printed')
    check = commands.add_parser('check')
    check.add_argument('files', nargs='+')
    rules = commands.add_parser('instructions')
    rules.add_argument('--grant-dir', default=os.environ.get('ORKESTR_V2_AGENT_TIMER_GRANT_DIR'))
    rules.add_argument('--tool', default='/usr/local/libexec/orkestr-reply-attach/reply_attach.py')
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    if args.action == 'instructions':
        print(RULES.format(grant_dir=args.grant_dir or '<grant dir>', tool=args.tool,
                           v2_url=args.v2_url or '<v2 url>', conversation=args.conversation or '<conversation>',
                           workspace=args.workspace or '<workspace>'), end='')
        return 0
    key = None
    try:
        files = read_files(args.workspace, args.files)
        if args.action == 'check':
            for name, media, data in files:
                print(json.dumps({'ok': True, 'filename': name, 'media_type': media, 'bytes': len(data),
                                  'sent': False}))
            return 0
        if not args.v2_url or not args.conversation:
            raise AttachError(0, 'v2_url_and_conversation_required')
        path = args.grant_file
        if not path and not os.environ.get('ORKESTR_V2_AGENT_TIMER_GRANT'):
            path = grant_path(args.conversation)
        client = Client(args.v2_url, args.conversation, read_grant(path))
        key = args.request_key or default_key(args.conversation, files)
        lines = client.attach(files, key)
    except AttachError as failure:
        line = {'ok': False, 'status': failure.status, 'code': failure.code, **failure.extra}
        if key:
            line['request_key'] = key
            line['retry'] = f'rerun the same command with --request-key {key}'
        print(json.dumps(line), file=sys.stderr)
        return ERROR_EXIT
    print('\n'.join(lines))
    names = ', '.join(name for name, _, _ in files)
    print(f'Attached {len(files)} file(s) to this conversation: {names} (request_key {key}). '
          'End your reply with the line(s) printed on stdout, unchanged, each on its own line.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
