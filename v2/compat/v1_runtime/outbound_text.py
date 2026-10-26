"""Chat-safe outbound text: no mid-sentence progress, no server-local paths.

Core stores a Deep progress snapshot while the model is still writing the
item, so a snapshot can stop mid-sentence ("There are two", "- **"). Progress
is exported only when its text ends at a sentence or paragraph boundary, or
once the same snapshot has stayed the latest one for `PROGRESS_HOLD_S` (the
item stopped growing, so it is finished).

Replies in a chat shared with other members may reference files on the
host ("[Deck](/var/lib/.../deck.pptx)"). WhatsApp cannot open such a link and
the full path must not reach other members. The adapter has no outbound binary
attachment transport (exports are text; V1 only sends the reply documents it
renders itself), so a link to a local file, or a bare path that clearly ends
in a file name with an extension, becomes the file name marked
"(not attached)". Code (fenced blocks, inline spans), directories and routes
are never touched, and owner-only chats are not scrubbed at all.
"""
import re
from urllib.parse import unquote

# A held fragment is exported unchanged after it stayed the latest snapshot this long.
PROGRESS_HOLD_S = 20
# Sentence terminals; ":" is excluded because it usually introduces a list that follows.
_TERMINALS = ".!?…。！？"
# Closing marks that may follow a terminal ("**Done.**", "(see above.)", "\"Yes.\"").
_CLOSERS = "*_`)]}\"'”’»"

# Host roots whose absolute paths are server-local (never URLs).
_ROOTS = r"(?:home|var|tmp|root|srv|opt|mnt|data|run|etc|usr|workspace|private|Users)"
# A file name extension: 1-8 alphanumerics with at least one letter (not "python3.11").
_EXT = r"\.(?=[A-Za-z0-9]{0,7}[A-Za-z])[A-Za-z0-9]{1,8}"
# Markdown link or image to a local file: [label](<path>) (any characters) or
# [label](path) (spaces and parentheses allowed, must end in an extension).
_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*(?:<((?:file://)?/" + _ROOTS + r"/[^\n<>]*?" + _EXT + r")>"
                   r"|((?:file://)?/" + _ROOTS + r"/[^\n<>]*?" + _EXT + r"))\s*\)")
# A bare path ending in a file name, not inside a URL, a longer path or a word.
_SEGMENT = r"[^\s<>()\[\]`'\"/]+"
_BARE = re.compile(r"(?<![\w/:.~-])((?:file://)?/" + _ROOTS + r"/(?:" + _SEGMENT + r"/)*" + _SEGMENT + _EXT + r")(?![\w/])")
# Fenced code blocks (to their closing fence or the end) and inline code spans.
_CODE = re.compile(r"(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)|(`+)[^`]*?\3", re.S)


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
    return "%s (not attached)" % _name(match.group(1))


def _link(match):
    target = (match.group(2) or match.group(3)).strip()
    label, name = match.group(1).strip(), _name(target)
    if not label or label in (name, target):
        return "%s (not attached)" % name
    return "%s: %s (not attached)" % (label, name)


def _prose(text):
    return _BARE.sub(_bare, _LINK.sub(_link, text))


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
