"""Deterministic V1 thread-message row -> archived message mapping (no I/O besides uploads)."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re

ROLE = re.compile(r'^[a-z0-9_-]{1,32}$')
UNSETTLED = {'queued', 'pending', 'pending_delivery', 'running', 'awaiting_ack',
             'streaming', 'in_progress', 'delivering', 'claimed', 'sending'}
PATH_KEYS = ('path', 'saved_path', 'filePath', 'localPath')
TEXT_MAX = 1024 * 1024
ATTACHMENTS_MAX = 32
ATTACHMENT_BYTES_MAX = 512 * 1024 * 1024
# Registry fields copied for provenance; everything else (executor, bindings,
# routes, chat IDs, workspaces, credentials) is excluded by construction.
THREAD_FIELDS = ('id', 'name', 'publicRef', 'createdAt', 'updatedAt', 'parentThreadId', 'kind')


def safe_thread_id(thread_id):
    return re.sub(r'[^a-zA-Z0-9_.-]', '_', str(thread_id or '')) or 'default'


def thread_summary(record):
    if not isinstance(record, dict):
        return None
    return {key: record[key] for key in THREAD_FIELDS
            if isinstance(record.get(key), str) and record.get(key)}


class Skip(Exception):
    """Message cannot be represented faithfully; quarantined locally with a reason."""


def _clean(value, limit, reason):
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        raise Skip(reason)
    if value == '':
        return None
    if len(value.encode('utf-8', 'strict')) > limit or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in value):
        raise Skip(reason)
    return value


def _utf8(value, reason):
    try:
        value.encode('utf-8', 'strict')
    except UnicodeError as error:
        raise Skip(reason) from error
    return value


def role_of(row, data):
    role = str(row.get('role') or data.get('role') or data.get('kind') or 'unknown').strip().lower()
    if not ROLE.match(role):
        raise Skip('invalid_role')
    return role


def text_of(data):
    for key in ('text', 'content'):
        if isinstance(data.get(key), str):
            text = _utf8(data[key], 'invalid_unicode')
            if len(text.encode('utf-8')) > TEXT_MAX:
                raise Skip('text_too_large')
            return text
    return ''


# V1 marks a non-owner group participant's input with its verified sender and
# a non-owner trust level. Their author survives the import as `<label>: `.
OWNER_ROLES = {'owner', ''}
RELAY_HEADER = re.compile(r'^(\[WhatsApp: [^\]\n]{0,256}\]\n\n)(.*)$', re.S)
LABEL_MAX = 64


def participant_label(data):
    """Display label of a non-owner participant's user message, else None."""
    if not isinstance(data, dict):
        return None
    roles = {str(data.get(k) or '').strip().lower() for k in ('senderEffectiveRole', 'senderTrustLevel')}
    if roles <= OWNER_ROLES:
        return None
    for key in ('senderLabel', 'senderParticipantId'):
        value = data.get(key)
        if isinstance(value, str):
            value = ' '.join(value.replace(':', ' ').split())[:LABEL_MAX]
            if value and value.isprintable():
                return value
    return None


def authored_text(text, label):
    if not label:
        return text
    match = RELAY_HEADER.match(text)
    header, body = (match.group(1), match.group(2)) if match else ('', text)
    return f'{header}{label}: {body}'


def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_unsettled(row, now, window_seconds):
    """Recent nonterminal messages end the cut; long-stale ones are exported as-is."""
    if str(row.get('state') or '') not in UNSETTLED:
        return False
    stamp = parse_time(row.get('updated_at')) or parse_time(row.get('created_at'))
    return stamp is None or (now - stamp).total_seconds() < window_seconds


def upload_root(home, thread_id):
    return [Path(home, 'uploads', name).resolve() for name in {thread_id, safe_thread_id(thread_id)}]


def _inside(path, roots):
    return any(path == root or root in path.parents for root in roots)


def attachment_of(item, home, thread_id, store):
    """Copy an attachment that lives in this thread's upload directory; others stay references."""
    if not isinstance(item, dict):
        raise Skip('invalid_attachment')
    raw_name = next((item[k] for k in ('name', 'filename', 'fileName') if isinstance(item.get(k), str) and item[k]), None)
    raw_path = next((item[k] for k in PATH_KEYS if isinstance(item.get(k), str) and item[k]), None)
    name = raw_name or (os.path.basename(raw_path) if raw_path else 'attachment')
    name = ''.join(c for c in name if not (ord(c) < 32 or 127 <= ord(c) < 160))[:255].strip() or 'attachment'
    while len(name.encode('utf-8')) > 255:
        name = name[:-1]
    media = next((item[k] for k in ('mimetype', 'mimeType', 'mime_type', 'contentType') if isinstance(item.get(k), str)), None)
    media = media if media and len(media) <= 128 and media.isprintable() else None
    result = {'name': name, 'sha256': '', 'bytes': 0, 'media_type': media, 'available': False}
    reason = 'no_local_path'
    if raw_path:
        reason = 'outside_thread_uploads'
        candidate = Path(raw_path)
        if candidate.is_absolute():
            real = candidate.resolve()
            if _inside(real, upload_root(home, thread_id)):
                reason = 'missing_or_not_regular'
                if real.is_file() and not candidate.is_symlink():
                    size = real.stat().st_size
                    reason = 'too_large'
                    if size <= ATTACHMENT_BYTES_MAX:
                        sha, size = store(real)
                        result.update(sha256=sha, bytes=size, available=True)
                        reason = None
    return result, reason


def message_of(row, home, thread_id, store):
    """Map one V1 row. Returns (message, attachment_reasons) or raises Skip."""
    try:
        data = json.loads(row['data'])
    except (TypeError, ValueError) as error:
        raise Skip('invalid_json') from error
    if not isinstance(data, dict):
        raise Skip('invalid_json')
    attachments, reasons = [], []
    raw = data.get('attachments') or []
    if not isinstance(raw, list) or len(raw) > ATTACHMENTS_MAX:
        raise Skip('invalid_attachment_list')
    for item in raw:
        attachment, reason = attachment_of(item, home, thread_id, store)
        attachments.append(attachment)
        if reason:
            reasons.append(reason)
    message = {
        'source_message_id': _clean(row['id'], 256, 'invalid_id'),
        'source_position': int(row['position']),
        'source_cursor': max(0, int(row.get('cursor') or 0)),
        'role': role_of(row, data),
        'phase': _clean(row.get('phase') or data.get('phase'), 64, 'invalid_phase'),
        'state': _clean(row.get('state') or data.get('state'), 64, 'invalid_state'),
        'source_kind': _clean(row.get('source') or data.get('source'), 64, 'invalid_source'),
        'created_at': _clean(row.get('created_at') or data.get('createdAt') or data.get('timestamp'), 64, 'invalid_time'),
        'updated_at': _clean(row.get('updated_at') or data.get('updatedAt'), 64, 'invalid_time'),
        'text': authored_text(text_of(data), participant_label(data) if role_of(row, data) == 'user' else None),
        'attachments': attachments,
    }
    if not message['source_message_id'] or message['source_position'] < 1:
        raise Skip('invalid_identity')
    return message, reasons


def content_store(directory):
    """Content-addressed private copy; returns (sha256, bytes)."""
    directory.mkdir(mode=0o700, exist_ok=True)

    def store(path):
        digest, size = hashlib.sha256(), 0
        with open(path, 'rb') as stream:
            data = stream.read()
        digest.update(data)
        size = len(data)
        sha = digest.hexdigest()
        target = directory / sha
        if not target.exists():
            with open(target, 'xb') as out:
                os.chmod(target, 0o600)
                out.write(data)
        return sha, size
    return store
