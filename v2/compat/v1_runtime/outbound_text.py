"""Chat-safe outbound text: no mid-sentence progress, no server-local paths.

Core stores a Deep progress snapshot while the model is still writing the
item, so a snapshot can stop mid-sentence ("There are two", "- **"). Progress
is exported only when its text ends at a sentence or paragraph boundary, or
once the same snapshot has stayed the latest one for `PROGRESS_HOLD_S` (the
item stopped growing, so it is finished).

Replies may reference files on the host ("[Deck](/var/lib/.../deck.pptx)").
WhatsApp cannot open such a link and the full path must never leave the
host. The adapter has no outbound binary attachment transport (exports are
text; V1 only sends the reply documents it renders itself), so each local
path is replaced by its file name marked "(not attached)".
"""
import re
from urllib.parse import unquote

# A held fragment is exported unchanged after it stayed the latest snapshot this long.
PROGRESS_HOLD_S = 20
# Sentence terminals; ":" is excluded because it usually introduces a list that follows.
_TERMINALS = ".!?…。！？"
# Closing marks that may follow a terminal ("**Done.**", "(see above.)", "\"Yes.\"").
_CLOSERS = "*_`)]}\"'”’»"

# Host roots whose absolute paths are server-local (never URLs or API routes).
_ROOTS = r"(?:home|var|tmp|root|srv|opt|mnt|data|run|etc|usr|workspace|private|Users)"
_PATH = r"(?:file://)?/" + _ROOTS + r"/[^\s<>()\[\]`'\"]+"
# Markdown link or image whose target is a local path: [label](path) / [label](<path>).
_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*<?((?:file://)?/" + _ROOTS + r"/[^\n<>()]+?)>?\s*\)")
# A bare path, not inside a URL or a longer path (no word char, "/", ":" or "." just before).
_BARE = re.compile(r"(?<![\w/:.~-])(" + _PATH + r")")
_TRAILING = ".,;:!?"


def complete_progress(text):
    """True when a progress snapshot ends at a sentence or paragraph boundary."""
    if not isinstance(text, str):
        return False
    if text.endswith("\n\n") and text.strip():
        return True
    body = text.rstrip()
    stripped = body.rstrip(_CLOSERS).rstrip()
    if not stripped:
        return False
    # "- **" strips to a bare list marker and "**Plan: about" has no terminal.
    return stripped[-1] in _TERMINALS


def _name(path):
    path = path[len("file://"):] if path.startswith("file://") else path
    name = unquote(path.rstrip("/").rsplit("/", 1)[-1]).strip()
    return name or "file"


def _bare(match):
    path = match.group(1)
    tail = ""
    while path and path[-1] in _TRAILING:
        tail, path = path[-1] + tail, path[:-1]
    if path.count("/") < 2:
        return match.group(0)
    return "%s (not attached)%s" % (_name(path), tail)


def _link(match):
    label, name = match.group(1).strip(), _name(match.group(2).strip())
    if not label or label == name or label == match.group(2).strip():
        return "%s (not attached)" % name
    return "%s: %s (not attached)" % (label, name)


def scrub_local_paths(text):
    """Replace every server-local absolute path with its bare file name."""
    if not isinstance(text, str) or "/" not in text:
        return text
    return _BARE.sub(_bare, _LINK.sub(_link, text))
