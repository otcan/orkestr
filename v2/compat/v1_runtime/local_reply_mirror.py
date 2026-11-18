"""Group copy of a real reply to V1-local input.

A V1-local input (connected assistant, CLI `orkestr send`, thread watch,
Worker, mailbox, V1 web UI; see local_inputs.py) is answered to its
requester in Orkestr: V1 keeps that reply in the V1 thread, where the
requester reads it, and acknowledges it `suppressed`. The owner also wants
every real reply of a thread on WhatsApp. So the accepted final (or refusal
notice) of such an input is copied once to the chat as its own pseudo timer
turn: the shape V1 already materializes for V2 timers, posts and web answers,
and the scoped relay already delivers, deduplicates and acknowledges. The
original reply still returns to the requester unchanged.

The copy opens with a header naming the requester and, unless the input is
external (untrusted) content, a one-line excerpt of the request, so the group
can tell what it answers. The full request is not posted.

Never copied: an exact NO_REPLY or empty reply, progress and Quick notes
(interim), inputs admitted before this rule (`group_mirror` absent: their
note told the model the reply stays private), inputs whose requester opted
out (`origin.groupReply: false`) and bindings with `local_reply_mirror:
false`. The copy is keyed by the input and the exported reply, written in the
caller's transaction, and a replay adopts nothing new. Nothing here sends.
"""
import time
import uuid

from . import notices
from .layer_identity import IDENTITY_FIELDS
from .ledger import LOCAL_ROLES

NAMESPACE = uuid.UUID("4f6c2d1a-9b7e-4c35-8e0a-6d2b9f1c7a54")
# The pseudo timer's source id: a named transport source, not a reminder, so
# the relay adds no timer header and V1 types the copy as a final answer.
SOURCE_ID = "local-reply"
EXCERPT_CHARS = 80
MAX_FILE_NAMES = 8


def wanted(data, kind, message):
    """Whether this newly exported message of `data` gets a group copy."""
    author = data.get("author") or {}
    text = message.get("text") if isinstance(message, dict) else None
    return (kind == "final" and data.get("origin") is None and author.get("role") in LOCAL_ROLES
            and author.get("group_mirror") is True and not message.get("noReply")
            and isinstance(text, str) and bool(text.strip()) and text.strip() != "NO_REPLY")


def excerpt(text, limit=EXCERPT_CHARS):
    words = " ".join(str(text or "").split())
    return words if len(words) <= limit else words[:limit].rstrip() + "…"


def file_names(message):
    names = []
    for item in message.get("attachments") or ():
        name = " ".join(str((item or {}).get("filename") or (item or {}).get("name") or "").split())[:120]
        if name and name not in names:
            names.append(name)
    if len(names) > MAX_FILE_NAMES:
        names = names[:MAX_FILE_NAMES] + ["…"]
    return names


def compose(lang, data, message):
    """(header, text) of the group copy."""
    author = data["author"]
    header = notices.render(lang, "local_reply_header", label=author.get("label") or "Orkestr")
    lines = [header]
    request = excerpt(data.get("text")) if author["role"] != "v1_external" else ""
    if request:
        lines.append("> " + request)
    text = "\n".join(lines) + "\n\n" + message["text"].strip()
    names = file_names(message)
    if names:
        text += "\n\n" + notices.render(lang, "local_reply_files", files=", ".join(names))
    return header, text


def copy(ledger, db, data, message):
    """Export the group copy of `message`, in the caller's transaction.

    Returns the copy's reply, or None when it already exists."""
    header, text = compose(notices.language_for(db, data), data, message)
    key = "%s:%s" % (data["remote_id"], message["id"])
    remote_id = str(uuid.uuid5(NAMESPACE, "copy:" + key))
    reply = {"id": str(uuid.uuid5(NAMESPACE, "copy-reply:" + key)), "role": "assistant", "state": "completed",
             "phase": "final_answer", "source": message.get("source") or "rust-v2-pilot",
             "parentMessageId": remote_id, "text": text}
    reply.update({k: message[k] for k in IDENTITY_FIELDS if message.get(k)})
    if message.get("kind") == "notice":
        reply["kind"] = "notice"
    if message.get("attachments"):
        reply["attachments"] = list(message["attachments"])
    extra = {"local_reply_for": {"input_id": data["remote_id"], "export_id": message["id"],
                                 "source": (data.get("author") or {}).get("source")}}
    created = ledger._pseudo_timer(db, remote_id, header, int(time.time() * 1000), extra, reply, source_id=SOURCE_ID)
    return reply if created else None
