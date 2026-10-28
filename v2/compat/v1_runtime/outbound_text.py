"""Chat-safe outbound text: no mid-sentence progress, no server-local paths.

Core stores a Deep progress snapshot while the model is still writing the
item, so a snapshot can stop mid-sentence ("There are two", "- **"). Progress
is exported only when its text ends at a sentence or paragraph boundary, or
once the same snapshot has stayed the latest one for `PROGRESS_HOLD_S` (the
item stopped growing, so it is finished).

A complete snapshot is also held, for `PROGRESS_SETTLE_S`: the item a Deep
turn ends with is stored as a progress snapshot a few milliseconds before the
turn completes with the same text as its final answer. Exporting that snapshot
at once posted the final answer twice (biofuture, 2026-10-27 14:03Z). A
snapshot is progress only once the run is still running after it settled; if
the run completes first, the final is the only copy.

Replies in a chat shared with other members (every chat whose binding is not
marked `owner_only_verified` with no participants) may reference files on the host ("[Deck](/var/lib/.../deck.pptx)").
WhatsApp cannot open such a link and the full path must not reach other
members. The adapter has no outbound binary attachment transport (exports are
text; V1 only sends the reply documents it renders itself), so a link to a
local file, or a bare path that ends in a file name with an extension, becomes
the file name marked "(not attached)". Any other absolute path under a host
folder root (/home, /var, /opt, /srv, /tmp, /etc, /root) -- a folder or a file
without an extension -- becomes "the server folder <last segment>". Code
(fenced blocks, inline spans), URLs and API routes (a path after an HTTP verb,
or under /api, /run, /data) are never touched, and verified owner-only chats
are not scrubbed at all.
"""
import re
from urllib.parse import unquote

# A held fragment is exported unchanged after it stayed the latest snapshot this long.
PROGRESS_HOLD_S = 20
# A complete snapshot must stay the latest, with the run still running, this long.
PROGRESS_SETTLE_S = 5
# Sentence terminals; ":" is excluded because it usually introduces a list that follows.
_TERMINALS = ".!?…。！？"
# Closing marks that may follow a terminal ("**Done.**", "(see above.)", "\"Yes.\"").
_CLOSERS = "*_`)]}\"'”’»"

# Host roots whose absolute paths are server-local (never URLs).
# /api, /run and /data are left out: paths under them are usually API routes.
_ROOTS = r"(?:home|var|tmp|root|srv|opt|mnt|etc|usr|workspace|private|Users)"
# A file name extension: 1-8 alphanumerics with at least one letter (not "python3.11").
_EXT = r"\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}"
# Markdown link or image to a local file: [label](<path>) (any characters) or
# [label](path) (spaces and balanced parentheses allowed, must end in an extension).
_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*(?:<((?:file://)?/" + _ROOTS + r"/[^\n<>]*?" + _EXT + r")>"
                   r"|((?:file://)?/" + _ROOTS + r"/(?:[^\n<>()]|\([^\n<>()]*\))*?" + _EXT + r"))\s*\)")
# Host folder roots: any path under them is server-local, folder or file.
_FOLDER_ROOTS = r"(?:home|var|opt|srv|tmp|etc|root)"
# Markdown link to a local folder (or a file without an extension); no spaces.
_FOLDER_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*<?((?:file://)?/" + _FOLDER_ROOTS + r"/[^\s<>()]+?)>?\s*\)")
# A bare absolute path (no spaces), not inside a URL, a longer path or a word.
_SEGMENT = r"[^\s<>()\[\]`'\"/]+"
_BARE = re.compile(r"(?<![\w/:.~-])((?:file://)?/" + _ROOTS + r"/(?:" + _SEGMENT + r"/)*" + _SEGMENT + r"/?)(?![\w/])")
_FILE_NAME = re.compile(r"[^/]" + _EXT + r"$")
_FOLDER_PATH = re.compile(r"^(?:file://)?/" + _FOLDER_ROOTS + r"/")
# A path right after an HTTP verb is an API route ("POST /run/start").
_TRAILING = ".,;:!?"
_VERB = re.compile(r"\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+$")
# Fenced code blocks (to their closing fence or the end) and inline code spans.
_CODE = re.compile(r"(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)|(?<!`)(`+)(?!`).*?(?<!`)\3(?!`)", re.S)


def progress_hold_s(held):
    """How long a held snapshot must stay the latest before it is exported."""
    return PROGRESS_SETTLE_S if held.get("complete") else PROGRESS_HOLD_S


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


def _folder(path):
    return "the server folder %s" % _name(path)


def _bare(match):
    path, tail = match.group(1), ""
    while path[-1] in _TRAILING:
        tail, path = path[-1] + tail, path[:-1]
    if _VERB.search(match.string[:match.start()]):
        return match.group(0)
    if _FILE_NAME.search(path.rstrip("/")) and not path.endswith("/"):
        return "%s (not attached)%s" % (_name(path), tail)
    if _FOLDER_PATH.match(path):
        return _folder(path) + tail
    return match.group(0)


def _folder_link(match):
    label, target = match.group(1).strip(), match.group(2).strip()
    if _VERB.search(match.string[:match.start()]):
        return match.group(0)
    return "%s (%s)" % (label, _folder(target)) if label and label != target else _folder(target)


def _link(match):
    target = (match.group(2) or match.group(3)).strip()
    label, name = match.group(1).strip(), _name(target)
    if not label or label in (name, target):
        return "%s (not attached)" % name
    return "%s: %s (not attached)" % (label, name)


def _prose(text):
    return _BARE.sub(_bare, _FOLDER_LINK.sub(_folder_link, _LINK.sub(_link, text)))


def scrub_local_paths(text):
    """Replace server-local file references outside code with their file names."""
    if not isinstance(text, str) or "/" not in text:
        return text
    parts, at = [], 0
    for code in _CODE.finditer(text):
        parts.append(_prose(text[at:code.start()]))
        parts.append(code.group(0))
        at = code.end()
    parts.append(_prose(text[at:]))
    return "".join(parts)
