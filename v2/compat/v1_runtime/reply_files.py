"""Files a Deep turn attached to its reply with the reply-attach tool (ORK-779).

The tool stores each file in the conversation's attachment store and the agent
ends its reply with one marker line per file:
`[orkestr-attachment manifest=<id> reference=<id> name="..."]`. Before the
reply is exported, `prepare` takes the markers out of the text and, for each
file that Core confirms is an agent attachment of THIS binding's conversation,
adds a descriptor V1 imports as a remote attachment of the reply:
`{id, filename, mimetype, size, sha256}` (id is the store reference).

V1 then fetches the bytes from this adapter
(`GET /threads/<remote>/attachments/<id>/download`, see `server.py`) and sends
them with the reply through the chat's own reply route, like its text. The
adapter serves only files of its binding's unsettled exports, read from Core's
delivery copy (`$ORKESTR_V2_ADAPTER_CORE_EXPORT_DIR/<conversation>/<sha256>.<ext>`)
and checked against Core's digest. It never sends WhatsApp itself. A file it
cannot verify is named "<name> (not attached)" in the text instead.

Sending is off unless `ORKESTR_V2_ADAPTER_REPLY_FILES=on`: a V1 that predates
remote reply files (ORK-779, V1 side) cannot import a reply that carries
attachments while it requires attachment encryption, and would lose the reply.
While off, the markers still leave the text and each file is named
"<name> (attached in the Orkestr app)", where the web chat shows it.
"""
import hashlib
import os
import re
import stat

EXPORT_DIR_ENV = "ORKESTR_V2_ADAPTER_CORE_EXPORT_DIR"
SWITCH_ENV = "ORKESTR_V2_ADAPTER_REPLY_FILES"
MAX_FILES = 8
MAX_BYTES = 16 * 1024 * 1024
# Exactly the types the WhatsApp worker sends (whatsapp-scoped-reply-files.js).
MEDIA_TYPES = frozenset((
    "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation", "text/csv", "text/plain",
    "text/markdown", "image/png", "image/jpeg", "image/webp", "application/zip"))
_ID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
MARKER = re.compile(r'^[ \t]*\[orkestr-attachment manifest=(%s) reference=(%s)( [^\]\n]*)?\][ \t\r]*$' % (_ID, _ID))
NAME = re.compile(r'name="([^"\n]{1,120})"')
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
NIL = "00000000-0000-0000-0000-000000000000"


def split(text):
    """(text without marker lines, [(manifest, reference, name)]) in order,
    without repeats. A text without markers is returned unchanged."""
    if not isinstance(text, str) or "[orkestr-attachment " not in text:
        return text, []
    kept, found = [], []
    for line in text.split("\n"):
        match = MARKER.match(line)
        if not match:
            kept.append(line)
            continue
        manifest, reference = match.group(1).lower(), match.group(2).lower()
        name = NAME.search(match.group(3) or "")
        if NIL not in (manifest, reference) and all((manifest, reference) != f[:2] for f in found):
            found.append((manifest, reference, name.group(1) if name else None))
    if not found:
        return text, []
    clean = re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()
    return clean, found


def strip(text):
    """The text without marker lines (exports that never carry files)."""
    return split(text)[0]


def _walk(path):
    """A directory fd, every component opened without following links."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in [p for p in path.split("/") if p]:
            if part in (".", ".."):
                raise OSError("export_path")
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_export(conversation, sha256, size, environ=os.environ):
    """Core's delivery copy with exactly this digest and size, or None."""
    directory = environ.get(EXPORT_DIR_ENV, "").strip()
    if (not directory.startswith("/") or not UUID.match(str(conversation)) or not SHA256.match(str(sha256))
            or type(size) is not int or not 0 < size <= MAX_BYTES):
        return None
    try:
        folder = _walk(directory.rstrip("/") + "/" + conversation)
    except OSError:
        return None
    try:
        names = sorted(n for n in os.listdir(folder)
                       if n == sha256 or re.fullmatch(re.escape(sha256) + r"\.[a-z0-9]{1,8}", n))
        for name in names:
            try:
                handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=folder)
            except OSError:
                continue
            try:
                info = os.fstat(handle)
                if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                    continue
                data = b"".join(iter(lambda: os.read(handle, 1024 * 1024), b""))
            finally:
                os.close(handle)
            if len(data) == size and hashlib.sha256(data).hexdigest() == sha256:
                return data
    except OSError:
        return None
    finally:
        os.close(folder)
    return None


def _descriptor(reference):
    """The descriptor of one available, sendable store reference, or None."""
    if not isinstance(reference, dict) or reference.get("state") != "available":
        return None
    name, media, size, digest = (reference.get(k) for k in ("filename", "media_type", "byte_length", "sha256"))
    if (not isinstance(name, str) or not 0 < len(name.encode()) <= 255 or any(c in name for c in "/\\\0\n\r")
            or media not in MEDIA_TYPES or type(size) is not int or not 0 < size <= MAX_BYTES
            or not isinstance(digest, str) or not SHA256.match(digest)):
        return None
    return {"id": reference.get("reference_id"), "filename": name, "mimetype": media, "size": size, "sha256": digest}


def enabled(environ=os.environ):
    return environ.get(SWITCH_ENV, "").strip() == "on"


def prepare(worker, text):
    """(text for the chat, attachment descriptors) of one reply.

    Transient Core failures propagate, so the step is retried with the same
    reply; anything definite only drops that file, never the reply."""
    clean, found = split(text)
    if not found:
        return text, []
    if not enabled():
        names = [n if isinstance(n, str) and n.strip() else "file" for _, _, n in found]
        return (clean + "\n\n" if clean else "") + "\n".join(
            "%s (attached in the Orkestr app)" % n for n in names), []
    conversation = str(getattr(worker.client, "conversation", ""))
    manifests, attachments, missing, total = {}, [], [], 0
    for manifest, reference, name in found:
        descriptor = None
        if getattr(worker, "attachments", False) and len(attachments) < MAX_FILES:
            if manifest not in manifests:
                from .rust_client import ClientError
                try:
                    manifests[manifest] = worker.call("GET", "/agent-attachments/" + manifest)
                except ClientError as error:
                    from .worker import transient
                    if transient(error):
                        raise
                    manifests[manifest] = None
            value = manifests[manifest]
            if (isinstance(value, dict) and value.get("conversation_id") == conversation
                    and value.get("manifest_id") == manifest and isinstance(value.get("references"), list)):
                match = next((r for r in value["references"]
                              if isinstance(r, dict) and r.get("reference_id") == reference), None)
                descriptor = _descriptor(match)
                name = descriptor["filename"] if descriptor else (match or {}).get("filename") or name
        if (descriptor and total + descriptor["size"] <= MAX_BYTES
                and read_export(conversation, descriptor["sha256"], descriptor["size"]) is not None):
            total += descriptor["size"]
            attachments.append(descriptor)
        else:
            missing.append(name if isinstance(name, str) and name.strip() else "file")
    if missing:
        clean = (clean + "\n\n" if clean else "") + "\n".join("%s (not attached)" % n for n in missing)
    return clean, attachments


def exported(ledger, attachment_id):
    """The descriptor of `attachment_id` in one of the ledger's unsettled exports, or None."""
    import json
    if not isinstance(attachment_id, str) or not UUID.match(attachment_id):
        return None
    with ledger.connect() as db:
        rows = db.execute("SELECT message FROM exports WHERE (outcome IS NULL OR outcome='uncertain') "
                          "AND instr(message, ?) > 0 ORDER BY seq", (attachment_id,)).fetchall()
    for (raw,) in rows:
        try:
            items = json.loads(raw).get("attachments")
        except (ValueError, AttributeError):
            continue
        for item in items if isinstance(items, list) else ():
            if isinstance(item, dict) and item.get("id") == attachment_id:
                return dict(item)
    return None
