"""`/switch`: the owner's model switch from any owner WhatsApp chat, without a model turn.

The adapter consumes a `/switch ...` message at intake: it is stored as a
completed input (no Fast, no Deep, no burst ever sees it) and this binding's
worker answers it through the ordinary export path. Only the verified WhatsApp
owner may switch; members, V1-local senders (agents, threads, CLI) and timers
are refused with a reply. Every change runs the root-owned
`orkestr-model-switch` tool with a fixed, validated argument list (never a
shell): a dry run first, then the apply. A provider switch needs `/switch yes`
from the owner within two minutes. The tool writes its own record and
COORDINATION.md line; the adapter also logs one `SWITCH` line per call.

  /switch status | help | yes | back [all]
  /switch deep|fast <model|default> [effort] [all | for claude] [from <old>]
"""
import json
import os
import re
import time
import uuid

from .participants import split_header
from .switch_tool import Switcher, first_line, log, plan_lines, planned_count, reason  # noqa: F401 (re-exported)

COMMAND = re.compile(r"^/switch(?:\s|$)", re.I)
MODEL = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")
EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
CLAUDE_HINT = re.compile(r"^(claude|opus|sonnet|haiku)", re.I)
KEYWORDS = ("deep", "fast", "all", "for", "from", "status", "back", "yes", "help", "claude", "codex")
CONFIRM_S = 120
CLAUDE_EFFORTS = ("low", "medium", "high", "max")
# Shorthand targets: `/switch claude` and `/switch codex` (the configured
# global Codex default wins over CODEX_DEFAULT when the tool reports one).
CLAUDE_DEFAULT = "opus"
CODEX_DEFAULT = "gpt-6.1-sol"
PENDING_KEY = "switch_pending"
NAMESPACE = uuid.UUID("2a7c4e91-5b3d-4f08-9e6a-c1d2b3a4f5e6")
FOOTER = "\n\n⚙️ /switch · handled by the adapter, no model turn"
PLAN_LIMIT = 6
HELP = ("Model switch (owner only, handled without a model turn):\n"
        "/switch status: this chat's Deep and Fast model, plus all chats\n"
        "/switch deep <model> [effort]: this chat's Deep\n"
        "/switch fast <model> [effort]: this chat's Fast (Codex chats)\n"
        "  add `all` for every Codex chat, `from <old>` to change only chats on <old>\n"
        "  `default` as model or effort clears the override\n"
        "/switch claude | /switch codex: this chat's Deep to that provider's default model (asks /switch yes)\n"
        "/switch deep <codex model> for claude: move the Claude chats to Codex (asks /switch yes)\n"
        "/switch back: undo the latest switch of this chat; /switch back all: the latest fallback switch\n"
        "/switch yes: confirm a provider switch within 2 minutes\n"
        "Example: /switch deep gpt-6.1-sol high")


class Invalid(ValueError):
    pass


def command_text(text):
    """The message without V1's `[WhatsApp: <group>]` header, or None."""
    if not isinstance(text, str):
        return None
    body = split_header(text)[1].strip()
    return body if COMMAND.match(body) else None


def denied(value):
    """Never a Fable model, in any spelling or position (owner policy)."""
    return "fable" in value.lower()


def model_ok(value):
    return (value == "default" or (bool(MODEL.match(value)) and not value.isdigit() and
                                   value.lower() not in KEYWORDS + ("openai", "azure", "openrouter")))


def parse(text):
    """One `/switch` command as a dict; raises Invalid with the reason."""
    words = text.split()[1:]
    if any(denied(w) for w in words):
        raise Invalid("Fable models are not allowed.")
    low = [w.lower() for w in words]
    if not words or low == ["help"]:
        return {"op": "help"}
    if low == ["status"]:
        return {"op": "status"}
    if low == ["yes"]:
        return {"op": "yes"}
    if low in (["back"], ["back", "all"]):
        return {"op": "back", "all": len(low) == 2}
    if low in (["claude"], ["codex"], ["deep", "claude"], ["deep", "codex"], ["fast", "claude"], ["fast", "codex"]):
        # Shorthand: this chat's layer to that provider's default model.
        return {"op": "provider", "layer": "fast" if low[0] == "fast" else "deep", "provider": low[-1]}
    if low[0] not in ("deep", "fast"):
        raise Invalid("Unknown /switch form.")
    if len(words) < 2 or not model_ok(words[1]):
        raise Invalid("Give a model name, for example /switch %s gpt-6.1-sol." % low[0])
    out = {"op": "set", "layer": low[0], "model": words[1], "effort": None, "scope": "chat", "from": None}
    i = 2
    while i < len(words):
        w = low[i]
        if w == "all" and out["scope"] == "chat":
            out["scope"] = "all"
        elif w == "for" and i + 1 < len(words) and low[i + 1] == "claude" and out["scope"] == "chat":
            if out["layer"] != "deep":
                raise Invalid("`for claude` is only for Deep: Fast preferences are Codex-only.")
            out["scope"] = "claude"
            i += 1
        elif w == "from" and i + 1 < len(words) and out["from"] is None and model_ok(words[i + 1]):
            out["from"] = words[i + 1]
            i += 1
        elif (w in EFFORTS or w == "default") and out["effort"] is None and i == 2:
            out["effort"] = w
        else:
            raise Invalid("I did not understand %r." % words[i])
        i += 1
    if out["scope"] == "claude" and CLAUDE_HINT.match(out["model"]):
        raise Invalid("`for claude` moves Claude chats to a Codex model; %s is a Claude model." % out["model"])
    return out


def bullet(lines):
    shown = ["• " + line for line in lines[:PLAN_LIMIT]]
    if len(lines) > PLAN_LIMIT:
        shown.append("• … and %d more" % (len(lines) - PLAN_LIMIT))
    return "\n".join(shown)


# ------------------------------------------------------------------ commands

def describe(layer, model, effort, provider=None):
    return "%s%s/%s" % ((provider + ":") if provider else "", model or "default", effort or "default")


def chat_row(status, conversation):
    return next((c for c in status.get("chats") or [] if c.get("conversation") == conversation), None)


def status_text(status, conversation):
    row = chat_row(status, conversation)
    codex = status.get("global_codex_default") or {}
    lines = []
    if row:
        provider = row.get("provider") or "codex"
        deep = row.get("model") or ("default (%s)" % codex.get("model") if provider == "codex" else "default")
        lines.append("This chat (%s):" % (row.get("name") or "?"))
        lines.append("\U0001f9e0 Deep: %s %s, effort %s" % (provider, deep, row.get("effort") or "default"))
        if provider == "codex":
            fast = row.get("fast") or {}
            lines.append("⚡ Fast: %s, effort %s" % (fast.get("model") or "same as Deep", fast.get("effort") or "default"))
        else:
            lines.append("⚡ Fast: Claude chat (Fast preferences are Codex-only)")
    else:
        lines.append("This chat has no live V2 settings row.")
    count = lambda d: ", ".join("%s ×%s" % kv for kv in sorted((d or {}).items(), key=lambda kv: -kv[1])) or "none"
    lines.append("")
    lines.append("All live chats: Deep %s; Fast %s" % (count(status.get("deep")), count(status.get("fast"))))
    lines.append("Global Codex default: %s/%s" % (codex.get("model") or "?", codex.get("effort") or "default"))
    effect = status.get("switches_in_effect") or []
    lines.append("Switches in effect: %s" % ("; ".join("%s → %s on %s" % (e.get("origin"), e.get("current"), e.get("targets"))
                                                      for e in effect) or "none"))
    return "\n".join(lines)


def set_args(cmd, conversation, status):
    """(args, needs confirmation) for a deep/fast change."""
    args = ["--layer", cmd["layer"], "--to", cmd["model"]]
    if cmd["effort"]:
        args += ["--effort", cmd["effort"]]
    provider = None
    if cmd["scope"] == "all":
        args += ["--scope", "codex"]
    elif cmd["scope"] == "claude":
        args += ["--scope", "claude"]
        provider = "codex"
    else:
        args += ["--scope", conversation]
        row = chat_row(status, conversation) or {}
        current = row.get("provider") or "codex"
        if cmd["layer"] == "deep" and cmd["model"] != "default":
            wanted = "claude" if CLAUDE_HINT.match(cmd["model"]) else "codex"
            if wanted != current:
                provider = wanted
    if cmd["from"]:
        args += ["--from", cmd["from"]]
    if provider:
        args += ["--provider", provider]
    return args, bool(provider)


def provider_args(cmd, conversation, status):
    """`/switch claude|codex` (and `fast ...`): (args, None) or (None, reply)."""
    row = chat_row(status, conversation)
    if not row:
        return None, "This chat has no live V2 settings row."
    current = row.get("provider") or "codex"
    if cmd["layer"] == "fast":
        if cmd["provider"] == "claude":
            return None, "Fast is Codex-only: there is no Claude Fast setting. /switch claude moves this chat's Deep."
        if current != "codex":
            return None, "This is a Claude chat: its Fast preferences are Codex-only and not used here."
        fast = row.get("fast") or {}
        return None, "Fast is already on Codex: %s, effort %s." % (fast.get("model") or "same as Deep",
                                                                   fast.get("effort") or "default")
    if current == cmd["provider"]:
        codex = (status.get("global_codex_default") or {}).get("model")
        model = row.get("model") or ("default (%s)" % codex if current == "codex" and codex else "default")
        return None, "Already on %s %s, effort %s.\n\n%s" % (current, model, row.get("effort") or "default",
                                                              status_text(status, conversation))
    if cmd["provider"] == "claude":
        effort = row.get("effort") if row.get("effort") in CLAUDE_EFFORTS else "high"
        model = CLAUDE_DEFAULT
    else:
        effort = "high"
        model = (status.get("global_codex_default") or {}).get("model") or CODEX_DEFAULT
        if not model_ok(model) or denied(model) or CLAUDE_HINT.match(model):
            model = CODEX_DEFAULT
    return ["--layer", "deep", "--to", model, "--effort", effort, "--scope", conversation,
            "--provider", cmd["provider"]], None


def back_args(conversation, status, history):
    """(args, needs confirmation, note) undoing the newest switch of this chat
    that still holds; None args when there is nothing to undo."""
    row = chat_row(status, conversation)
    if not row:
        return None, False, "This chat has no live V2 settings row."
    current = {"deep": {"provider": row.get("provider") or "codex", "model": row.get("model"), "effort": row.get("effort")},
               "fast": {"model": (row.get("fast") or {}).get("model"), "effort": (row.get("fast") or {}).get("effort")}}
    for record in history:
        if record.get("kind") != "switch" or record.get("layer") not in ("deep", "fast"):
            continue
        mine = [c for c in record.get("changed") or [] if c.get("conversation") == conversation]
        if not mine:
            continue
        change, layer = mine[0], record["layer"]
        after = {k: v for k, v in (change.get("after") or {}).items() if k in current[layer]}
        if any(current[layer].get(k) != v for k, v in after.items()):
            continue  # Changed again since: not the switch that is in effect here.
        before = change.get("before") or {}
        if len(record.get("changed") or []) == 1:
            confirm = before.get("provider") is not None and before.get("provider") != after.get("provider")
            return ["--revert", record["record"]], confirm, record["record"]
        args = ["--layer", layer, "--to", before.get("model") or "default", "--scope", conversation]
        if before.get("effort"):
            args += ["--effort", before["effort"]]
        confirm = layer == "deep" and before.get("provider") and before.get("provider") != after.get("provider")
        if confirm:
            args += ["--provider", before["provider"]]
        return args, bool(confirm), record["record"]
    return None, False, "Nothing to switch back in this chat: no switch of it is still in effect."


def undo_hint(args):
    scope = args[args.index("--scope") + 1] if "--scope" in args else None
    if scope in ("codex", "claude", "all"):
        return "/switch back to undo for this chat, /switch back all for every chat."
    return "/switch back to undo."


def applied_text(args, out, plan):
    lines = plan[1]
    out_lines = (out or "").splitlines()
    summary = next((l[len("applied: "):] for l in out_lines if l.startswith("applied: ")), "")
    counts = re.search(r"(\d+) (?:changed|restored), (\d+) skipped", summary)
    skipped = [l.strip()[len("skipped "):] for l in out_lines if l.strip().startswith("skipped ")]
    scope = args[args.index("--scope") + 1] if "--scope" in args else None
    if "--revert" in args:
        text = "✅ Switched back"
    else:
        where = {"codex": "all Codex chats", "claude": "the Claude chats"}.get(scope, "this chat")
        text = "✅ %s switched for %s" % (args[args.index("--layer") + 1].capitalize(), where)
    if counts:
        text += " (%s changed, %s skipped)" % counts.groups()
    text += ":\n" + bullet(lines) if lines else "."
    if skipped:
        text += "\nNot changed: " + "; ".join(skipped[:4])
    return text + "\n" + ("/switch back to undo." if "--revert" in args else undo_hint(args))


def execute(switcher, conversation, args, confirmed=False):
    """Dry run, then apply. Returns (reply text, pending dict or None)."""
    reason_args = ["--reason", "WhatsApp /switch by the owner in conversation %s" % conversation]
    code, out, err = switcher.call(args + ["--dry-run"] + (["--yes"] if confirmed else []), "dry")
    log(conversation, args + ["--dry-run"], code)
    if code != 0:
        return "❌ /switch refused: %s" % reason(err, code), None
    plan = plan_lines(out)
    if plan[0] is None and "--revert" in args:
        # "nothing to revert ..." or "... superseded ...": the tool says why.
        return "Nothing to switch back: %s" % (first_line(out) or "no switch in effect."), None
    if planned_count(plan[0]) == 0:
        return "Nothing to change: already on that setting.", None
    if not confirmed and ("--provider" in args or "PROVIDER SWITCH" in (plan[0] or "") or "WARNING" in out):
        provider = args[args.index("--provider") + 1] if "--provider" in args else "the previous provider"
        text = ("⚠️ Provider switch (%s):\n%s\nEach chat finishes its current turn, then continues on %s "
                "with a one-time handoff. Reply /switch yes within 2 minutes to apply."
                % (plan[0], bullet(plan[1]), provider))
        return text, {"args": args, "expires_at": time.time() + CONFIRM_S, "conversation": conversation}
    full = args + reason_args + (["--yes"] if confirmed else [])
    code, out, err = switcher.call(full, "apply")
    log(conversation, full, code, "applied" if code in (0, 1) else "failed")
    if code not in (0, 1):
        return "❌ /switch did not apply: %s" % reason(err, code), None
    return applied_text(args, out, plan), None


def answer(switcher, ledger, data, now=None):
    """The reply text for one stored command; never raises for a tool failure."""
    now = time.time() if now is None else now
    command = data["command"]
    conversation = command["conversation"]
    role = (data.get("author") or {}).get("role")
    if role != "owner" or data.get("origin"):
        log(conversation, ["refused", "role=%s" % (role or data.get("origin") or "unknown")], "-")
        return "Only the verified WhatsApp owner of this chat can use /switch. Nothing was changed."
    try:
        cmd = parse(command["text"])
    except Invalid as error:
        log(conversation, ["refused", "invalid"], "-")
        return "%s\n\n%s" % (error, HELP)
    if cmd["op"] == "help":
        return HELP
    if cmd["op"] == "yes":
        pending = pop_pending(ledger)
        if not pending or pending.get("conversation") != conversation or pending.get("expires_at", 0) < now:
            return "No provider switch is waiting for confirmation (it expires after 2 minutes). Send the /switch command again."
        return execute(switcher, conversation, pending["args"], confirmed=True)[0]
    try:
        status = switcher.status()
    except (RuntimeError, ValueError) as error:
        log(conversation, ["--status"], "failed")
        return "❌ Could not read the model settings: %s" % (str(error)[:300] or "status failed")
    if cmd["op"] == "status":
        return status_text(status, conversation)
    if cmd["op"] == "provider":
        args, note = provider_args(cmd, conversation, status)
        if args is None:
            return note
    elif cmd["op"] == "back":
        if cmd["all"]:
            args = ["--revert", "latest"]
        else:
            args, _, note = back_args(conversation, status, switcher.history())
            if args is None:
                return note
    else:
        args, _ = set_args(cmd, conversation, status)
    pop_pending(ledger)  # A new change replaces any waiting confirmation.
    text, waiting = execute(switcher, conversation, args)
    if waiting:
        save_pending(ledger, waiting)
    return text


def save_pending(ledger, value):
    with ledger.connect() as db:
        db.execute("INSERT INTO ledger_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (PENDING_KEY, json.dumps(value)))


def pop_pending(ledger):
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT value FROM ledger_meta WHERE key=?", (PENDING_KEY,)).fetchone()
        db.execute("DELETE FROM ledger_meta WHERE key=?", (PENDING_KEY,))
    try:
        return json.loads(row[0]) if row else None
    except ValueError:
        return None


# ------------------------------------------------------------------ ledger glue

def pending(ledger):
    with ledger.connect() as db:
        rows = db.execute("SELECT data FROM inputs WHERE json_extract(data,'$.command.state') IN ('queued','started') "
                          "ORDER BY rowid LIMIT 8").fetchall()
    return [json.loads(row[0]) for row in rows]


def mark(ledger, data, state, **extra):
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        data["command"].update(state=state, **extra)
        ledger.save(data, db)


def reply(ledger, data, text):
    """Export the command's one reply as its final answer (V1 delivers it as usual)."""
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        message = {"id": str(uuid.uuid5(NAMESPACE, data["remote_id"])), "role": "assistant", "state": "completed",
                   "phase": "final_answer", "kind": "notice", "source": "rust-v2-adapter", "command": "switch",
                   "parentMessageId": data["remote_id"], "text": text + FOOTER}
        data["command"].update(state="answered", answered_at=time.time())
        ledger.save(data, db)
        ledger._export(db, data, "final", "final:" + data["remote_id"], message)
    return message


def drive(worker, now=None):
    """Answer this binding's stored /switch commands. True when one was handled."""
    ledger = worker.ledger
    if not getattr(ledger, "commands_due", True):
        return False
    rows = pending(ledger)
    if not rows:
        ledger.commands_due = False
        return False
    switcher = getattr(worker, "switcher", None) or Switcher()
    for data in rows:
        if data["command"].get("state") == "started" and data["command"].get("pid") != os.getpid():
            # The adapter stopped while this command ran: never re-run an apply blindly.
            reply(ledger, data, "The adapter restarted while this /switch was running, so it may or may not have "
                                "applied. Check with /switch status.")
            continue
        mark(ledger, data, "started", started_at=time.time(), pid=os.getpid())
        try:
            text = answer(switcher, ledger, data, now)
        except Exception as error:  # A reply is owed whatever failed.
            log(data["command"]["conversation"], ["error"], type(error).__name__)
            text = "❌ /switch failed (%s). Nothing is retried; check /switch status." % type(error).__name__
        reply(ledger, data, text)
    return True
