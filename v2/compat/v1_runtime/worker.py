"""Serial, restart-safe Rust intake for one binding. Only the matched Deep run is mirrored."""
import grp
import os
from pathlib import Path
import re
import sys
import threading
import time
import uuid

from .ledger import (DEFAULT_MAX_INPUT_AGE_S, DIGEST_NAMESPACE as DIGEST_REPLY_NAMESPACE, PROGRESS_LIMIT, WEB_TEXT_LIMIT,
                     no_reply)
from . import instructions
from . import continuation_guard
from .participants import compose
from .rust_client import ClientError
from .model_identity import observed_identity
from .policy_refusal import notice as policy_notice
from .first_response import capture as capture_first_response

PROGRESS_INTERVAL_S = 60
PROGRESS_MAX_CHARS = 3500
TIMER_PAGE = 50
# Pass cadence. While an input is in flight a binding steps it every second;
# an idle binding sleeps until its next Rust poll is due (at most IDLE_PASS_S)
# and a new inbound input wakes it at once (see Signal). One host serves
# dozens of bindings, so idle polling dominates the adapter and server CPU.
PASS_S = 1
IDLE_PASS_S = 5
# Scheduled timer occurrences: a few seconds of pickup delay is invisible.
TIMER_POLL_S = 5
# Digests are due a few times a day.
DIGEST_POLL_S = 30
# Conversation posts are interactive (a coordinator or an operator alert).
POST_POLL_S = 5
POST_PAGE = 20
POST_AUTHORS = ("coordinator", "operator")
# Web-UI owner messages (snapshot `origin: "web"`) are mirrored to the group and
# their accepted Deep answer follows. Interactive, so looked for every 3 s.
WEB_POLL_S = 3
WEB_PAGE = 50
WEB_PAGES = 4
WEB_WATCHES_PER_PASS = 8
# An answer is awaited at most this long (above the 4 h window ceiling).
WEB_ANSWER_MAX_S = 5 * 3600
# A web message with no Deep run of its own once no window is open is dropped.
WEB_NO_RUN_GRACE_S = 120
DEEP_TERMINAL_PHASES = ("failed", "lost", "cancelled", "blocked", "stopped", "interrupted")
APP_FILES = re.compile(r"\n*\[Files attached in the Orkestr app[^\n]*:\n((?:- [^\n]*\n?)*)\]?", re.S)
# Runtime marker of an asynchronous question (Codex `request_user_input_async`)
# in a progress payload; must equal the runtime's ASYNC_QUESTION_PREFIX. Such a
# question is sent at once as its own message, never as the input's final.
QUESTION_PREFIX = "\u2753 Question while I keep working:\n\n"
QUESTION_LABEL = "Question"
# Progress payloads inspected per input for questions (bounded state).
QUESTION_SCAN_LIMIT = 1024
# Window states that are neither open for a follow-up nor closed for a successor.
UNSETTLED_WINDOW_STATES = ("opening", "retiring", "reconciliation_required")
# A Fast in these phases (or missing) can never become this input's proposal.
FAST_UNUSABLE_PHASES = ("failed", "lost", "cancelled", "blocked", "stopped", "interrupted", "completed")
FAST_GRACE_S = 60
# An input still not answered after this long gets one visible notice and an
# operator alert, so a silent hang cannot happen.
STALL_NOTICE_AFTER_S = 20 * 60
STALL_NOTICE = ("Still working on this message after more than 20 minutes. It may be stuck; "
                "Orkestr keeps retrying and the operator has been alerted.")
# Burst handling: WhatsApp messages sent in quick succession (text, then photos
# one by one) go to Rust as one input, so one turn answers all of them. A fresh
# input waits until the chat was quiet this long; a continuous stream holds the
# first input at most BURST_MAX_WAIT_S. The registry enables the wait.
DEFAULT_BURST_QUIET_S = 3.0
BURST_MAX_WAIT_S = 10.0
BURST_MAX_INPUTS = 8
BURST_TEXT_MAX_BYTES = 16 * 1024
BURST_NOTE = ("[%d messages arrived together and are delivered as one turn. Read all of them, then answer "
              "in a single reply that covers everything; do not reply to each message separately.]")
# Frozen per-attempt state dropped when an input is sent again as a new turn.
RESET_KEYS = ("intake", "cursor", "window", "window_request", "previous_window", "matched_runs", "accepted",
              "fast_accept_request", "deep_accept_request", "fast_payload", "deep_payload", "admitted_at",
              "progress_at", "fast_unusable_since", "intake_rules", "questions_scanned")
# An admitted input whose window ended without starting any run of it.
ORPHAN_GRACE_S = 60
# Deep phases a window work deadline leaves behind.
DEADLINE_STOP_PHASES = ("cancelled", "stopped", "interrupted")
CONTINUE_NOTICE = ("Continuing in a new turn: the previous turn reached its time limit "
                   "before it finished.")
CONTINUE_PREFIX = ("[The previous turn for this message reached its time limit and was stopped "
                   "before it finished. Continue the same task from where it stopped; do not "
                   "repeat steps that already succeeded.]\n\n")


class Refused(RuntimeError):
    """A safety condition requires operator reconciliation, never silent replay."""


# Failures that may clear by themselves; the same frozen request is retried.
# A revoked owner session refuses every binding until the service restarts, so
# it is not a property of the input.
TRANSIENT_CODES = ("transport_failed", "transport_outcome_unknown", "session_revoked")


def transient(error):
    code, status = getattr(error, "code", None), getattr(error, "status", None)
    if code is None or code in TRANSIENT_CODES:
        return True
    return code == "unexpected_status" and isinstance(status, int) and (status >= 500 or status in (408, 425, 429))


def refusal_reason(error):
    status = getattr(error, "status", None)
    return "upstream_refused:%s" % (status if status is not None else getattr(error, "code", "error"))


def attachment_note(text, manifest_id, references, paths=None):
    paths = paths or {}
    lines = ["[WhatsApp attachments imported into this conversation's attachment store, manifest %s:" % manifest_id]
    for r in references:
        line = "- %s (%s, %d bytes, reference %s" % (r["filename"], r["media_type"], r["byte_length"], r["reference_id"])
        path = paths.get(r["sha256"])
        lines.append(line + (", local file %s)" % path if path else ")"))
    if paths:
        lines.append("Open the local file to see an attachment (for an image use your image viewing tool).")
    return (text.rstrip() + "\n\n" if text.strip() else "") + "\n".join(lines) + "]"


MEDIA_EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
                    "application/pdf": ".pdf", "text/plain": ".txt"}


def attachment_export_settings(environ=os.environ):
    """Optional host directory where imported attachments are also written as
    files, so a provider turn (which receives text only) can open them.
    Returns (directory, gid) or (None, None) when not configured."""
    directory = environ.get("ORKESTR_V2_ADAPTER_ATTACHMENT_DIR", "").strip()
    if not directory or not os.path.isabs(directory):
        return None, None
    group = environ.get("ORKESTR_V2_ADAPTER_ATTACHMENT_GROUP", "").strip()
    try:
        gid = grp.getgrnam(group).gr_gid if group else None
    except KeyError:
        gid = None
    return directory, gid


def export_attachment(directory, gid, conversation, item, content):
    """Write one attachment as <dir>/<conversation>/<sha256><ext>, readable by
    the configured group only. Idempotent: the name is the content digest."""
    digest = item["sha256"]
    if not re.fullmatch("[0-9a-f]{64}", digest) or not re.fullmatch("[0-9a-zA-Z-]{1,64}", str(conversation)):
        return None
    suffix = MEDIA_EXTENSIONS.get(item["media_type"]) or "".join(
        c for c in Path(item.get("filename") or "").suffix.lower()[:8] if c.isalnum() or c == ".")
    folder = Path(directory) / conversation
    folder.mkdir(mode=0o750, parents=True, exist_ok=True)
    os.chmod(folder, 0o750)
    if gid is not None:
        os.chown(folder.parent, -1, gid)
        os.chown(folder, -1, gid)
    target = folder / (digest + suffix)
    if not target.exists():
        temporary = folder / (".%s.%s.tmp" % (digest, uuid.uuid4().hex))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
            if gid is not None:
                os.chown(temporary, -1, gid)
            os.chmod(temporary, 0o640)
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
    return str(target)


class Signal:
    """A binding's stop flag that a worker sleeps on.

    `wait` has `threading.Event` semantics (returns True once stopped);
    `wake` ends the current or next sleep early without stopping, so a new
    input is stepped at once instead of after the idle pause."""

    def __init__(self):
        self._condition = threading.Condition()
        self._stopped = self._woken = False

    def set(self):
        with self._condition:
            self._stopped = True
            self._condition.notify_all()

    def is_set(self):
        return self._stopped

    def wake(self):
        with self._condition:
            self._woken = True
            self._condition.notify_all()

    def wait(self, timeout=None):
        with self._condition:
            if not (self._stopped or self._woken):
                self._condition.wait(timeout)
            self._woken = False
            return self._stopped


class Worker:
    def __init__(self, client, ledger, progress_updates=False, max_input_age_s=DEFAULT_MAX_INPUT_AGE_S,
                 attachment_dir=None, attachment_gid=None, burst_quiet_s=0.0):
        self.client, self.ledger = client, ledger
        # 0 sends a fresh input at once; queued inputs are still merged.
        self.burst_quiet_s = burst_quiet_s
        self.attachment_dir, self.attachment_gid = attachment_dir, attachment_gid
        self.progress_updates = progress_updates
        self.max_input_age_s = max_input_age_s
        self._digest_checked = None
        self._posts_checked = None
        self._web_checked = None
        # Binding flags: mirror web-UI owner messages; name their files (else count only).
        self.web_mirror = True
        self.attachments = False
        self._timers_checked = None
        self._burst_due = None  # Wall time a waiting burst head may be sent.
        self._revoked_alerted = False
        # Optional per-binding chat rules file (see instructions.py); not pinned.
        self.instructions_path = None
        self.instructions_error = None

    def import_attachments(self, data):
        if "attachment_request" not in data:
            def reference(item, message=None):
                return {"reference_id": str(uuid.uuid4()), "message_id": message, "filename": item["filename"],
                        "media_type": item["media_type"], "byte_length": item["size"], "sha256": item["sha256"],
                        "state": "available"}
            source = [reference(item) for item in data["attachments"]]
            target = [dict(r, reference_id=str(uuid.uuid4())) for r in source]
            manifest = lambda conversation, refs: {"schema_version": 1, "manifest_id": str(uuid.uuid4()),
                "owner_id": self.client.owner, "conversation_id": conversation, "references": refs}
            # The source manifest only describes the transported bytes; the
            # server verifies length and digest of every copied object.
            data["attachment_request"] = {"request_key": data["keys"]["attachments"],
                "source": {"manifest": manifest(str(uuid.uuid4()), source)},
                "target_manifest": manifest(self.client.conversation, target),
                "mapping": [{"source_reference_id": a["reference_id"], "target_reference_id": b["reference_id"]}
                            for a, b in zip(source, target)]}
            self.ledger.save(data)
        request = dict(data["attachment_request"])
        contents, paths = [], {}
        for item, ref in zip(data["attachments"], request["source"]["manifest"]["references"]):
            content = self.ledger.upload_bytes(item["upload_id"])
            if content is None:
                raise Refused("attachment_bytes_missing")
            contents.append({"reference_id": ref["reference_id"], "bytes": list(content)})
            if self.attachment_dir:
                try:
                    path = export_attachment(self.attachment_dir, self.attachment_gid, self.client.conversation,
                                             item, content)
                except OSError:
                    path = None
                if path:
                    paths[item["sha256"]] = path
        request["source"] = dict(request["source"], contents=contents)
        receipt = self.client.import_attachments(request)
        target = request["target_manifest"]
        data["attachment_receipt"] = {"import_id": receipt["import_id"], "manifest_id": target["manifest_id"]}
        data["intake_text"] = attachment_note(compose(data), target["manifest_id"], target["references"], paths)
        self.ledger.save(data)
        self.ledger.release_uploads([item["upload_id"] for item in data["attachments"]])

    def capture_progress(self, data, status, ids):
        """Export distinct intermediate Deep payloads of this exact run, bounded and spaced."""
        if not self.progress_updates or not isinstance(status, dict) or status.get("phase") != "running":
            return
        payload_id = (status.get("progress") or {}).get("payload_id")
        seen = data.setdefault("progress_seen", [])
        if status.get("run_id") not in ids or not payload_id or payload_id in seen or len(seen) >= PROGRESS_LIMIT:
            return
        now = time.time()
        if now - data.get("progress_at", data.get("admitted_at", now)) < PROGRESS_INTERVAL_S:
            return
        payload = self.call("GET", "/payloads/" + payload_id)
        if payload.get("run_id") != status["run_id"] or payload.get("payload_id") != payload_id:
            raise Refused("progress_payload_mismatch")
        seen.append(payload_id)
        data["progress_at"] = now
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip() or no_reply(text):
            self.ledger.save(data)
            return
        if len(text) > PROGRESS_MAX_CHARS:
            text = text[:PROGRESS_MAX_CHARS].rstrip() + " …"
        self.ledger.add_progress(data, payload_id, text, self.provider_identity(run_id=status["run_id"], status=status))

    def capture_questions(self, data, events, ids):
        """Send each asynchronous question of this input's runs at once.

        A question is a marked progress payload. It is exported like a
        conversation post (its own message, not this input's final) whatever
        `progress_updates` says and without the progress spacing or limit, so
        the owner sees it while the turn continues to its single final.
        """
        scanned = data.setdefault("questions_scanned", [])
        for event in events:
            payload = event.get("payload_ref_or_safe_payload") or {}
            observation = payload.get("observation") or {}
            payload_id = observation.get("payload_id")
            if (payload.get("kind") != "provider_observed" or event.get("schema_version") != 8 or
                    observation.get("kind") != "progress_ref" or payload.get("run_id") not in ids or
                    not isinstance(payload_id, str) or payload_id in scanned or len(scanned) >= QUESTION_SCAN_LIMIT):
                continue
            try:
                value = self.call("GET", "/payloads/" + payload_id)
            except ClientError as error:
                if error.status not in (404, 410):
                    raise
                value = {}  # Removed payload: nothing left to send.
            scanned.append(payload_id)
            text = value.get("text") if value.get("payload_id") == payload_id else None
            if value and value.get("run_id") != payload["run_id"]:
                raise Refused("progress_payload_mismatch")
            if isinstance(text, str) and text.startswith(QUESTION_PREFIX) and text[len(QUESTION_PREFIX):].strip():
                uuid.UUID(payload_id)
                self.ledger.enqueue_post({"id": payload_id, "author": "assistant_question", "label": QUESTION_LABEL,
                                          "text": text, "provider": None, "model": None,
                                          "created_ms": int(time.time() * 1000)}, self.provider_identity(run_id=payload["run_id"]))
            self.ledger.save(data)

    def call(self, method, route, body=None, allowed=(200,)):
        return self.client.request(method, route, body=body, allowed=allowed)[1]

    def timer_inputs(self, after, limit=TIMER_PAGE):
        value = self.call("GET", "/timer-inputs?after_sequence=%d&limit=%d" % (after, limit))
        rows = value.get("inputs") if isinstance(value, dict) else None
        if not isinstance(rows, list) or len(rows) > limit:
            raise Refused("timer_inputs_shape")
        previous = after
        for row in rows:
            if (not isinstance(row, dict) or type(row.get("sequence")) is not int or row["sequence"] <= previous or
                    not str(row.get("request_key", "")).startswith("timer:") or
                    not all(isinstance(row.get(k), str) and row[k] for k in ("message_id", "event_id", "namespace", "claim_id"))):
                raise Refused("timer_inputs_shape")
            previous = row["sequence"]
        return rows

    def discover_timers(self):
        """Adopt V2 timer occurrences admitted in this binding's conversation.

        The first scan only records the current position: occurrences admitted
        before this adapter relayed timers are never replayed to WhatsApp.
        """
        cursor = self.ledger.timer_cursor()
        start = cursor or 0
        while True:
            rows = self.timer_inputs(start)
            for row in rows:
                if cursor is not None and not row.get("held"):
                    self.ledger.enqueue_timer(row)
                start = row["sequence"]
            if rows:
                self.ledger.set_timer_cursor(start)
            if len(rows) < TIMER_PAGE:
                break
        if cursor is None:
            self.ledger.set_timer_cursor(start)

    def timer_final(self, data, raw):
        """Final text to deliver, or None when silent. A timer run's answer is
        classified by Rust first (silent unless changed, NO_REPLY, digest-held);
        a server without the route keeps the ordinary reply settings only."""
        claim = (data.get("timer") or {}).get("claim_id") if data.get("origin") == "timer" else None
        if claim:
            try:
                value = self.call("POST", "/timer-outcomes", {"claim_id": claim, "text": raw})
            except ClientError as error:
                if error.status != 404:
                    raise
                value = None
            if value is not None:
                if not isinstance(value, dict) or type(value.get("deliver")) is not bool:
                    raise Refused("outcome_shape")
                if not value["deliver"]:
                    return None
        return self.render_final(raw)

    def fire_trigger(self, data):
        """Tell Rust a new inbound message arrived, for event-triggered timers.
        Best effort and idempotent by message id: a failure never blocks the input."""
        author = data.get("author") or {}
        if data.get("origin") or data.get("trigger_sent") or author.get("role") == "v1_agent":
            return
        try:
            self.call("POST", "/timer-triggers", {"source": "message", "event_key": str(data["public_id"])[:128]})
        except ClientError as error:
            if error.status is None or error.status >= 500:
                return
        except Exception:
            return
        data["trigger_sent"] = True
        self.ledger.save(data)
        # An event-triggered timer may now be admitted: look at the next pass.
        self._timers_checked = None

    def discover_digests(self):
        """Adopt digests Rust created for this conversation and acknowledge them
        once the ledger holds them; the ledger exports each as a normal reply."""
        value = self.call("GET", "/timer-digests?limit=20")
        rows = value.get("digests") if isinstance(value, dict) else None
        if not isinstance(rows, list) or len(rows) > 20:
            raise Refused("timer_digests_shape")
        for row in rows:
            if not (isinstance(row, dict) and all(isinstance(row.get(k), str) and row[k] for k in ("id", "namespace", "text"))):
                raise Refused("timer_digests_shape")
            self.ledger.enqueue_digest(row)
            self.client.request("POST", "/timer-digests/%s/delivered" % row["id"], body={}, allowed=(200,))

    def with_rules(self, data, text):
        """Prefix the binding's chat rules line, frozen with the input on first
        send so a retry resends exactly the same text. A missing or unreadable
        file sends without the line and is reported as `instructionsError`."""
        if "intake_rules" not in data:
            rules = ""
            if self.instructions_path:
                try:
                    rules = instructions.line(self.instructions_path)
                    self.instructions_error = None
                except ValueError as error:
                    self.instructions_error = str(error)
            else:
                self.instructions_error = None
            data["intake_rules"] = rules
            self.ledger.save(data)
        return data["intake_rules"] + "\n\n" + text if data["intake_rules"] else text

    def discover_posts(self):
        """Adopt conversation posts (assistant-side messages from outside a run)
        and acknowledge each once the ledger holds it. Adoption exports the post
        text unchanged as a final reply; V1 adds its own prefix and footer."""
        value = self.call("GET", "/posts?pending=true&limit=%d" % POST_PAGE)
        rows = value.get("posts") if isinstance(value, dict) else None
        if not isinstance(rows, list) or len(rows) > POST_PAGE:
            raise Refused("posts_shape")
        identity = None
        for row in rows:
            if not (isinstance(row, dict) and all(isinstance(row.get(k), str) and row[k].strip() for k in ("id", "label", "text"))
                    and row.get("author") in POST_AUTHORS and row.get("conversation_id") == self.client.conversation and
                    all(row.get(k) is None or (isinstance(row[k], str) and re.fullmatch("[A-Za-z0-9._:-]{1,64}", row[k]))
                        for k in ("provider", "model"))):
                raise Refused("posts_shape")
            uuid.UUID(row["id"])
            if identity is None:
                identity = self.provider_identity()
            self.ledger.enqueue_post(row, identity)
            self.client.request("POST", "/posts/%s/delivered" % row["id"], body={}, allowed=(200,))

    def web_text(self, text):
        """The owner's web message for WhatsApp: app attachment notes become one
        line (file names with `attachments`, else only the count); bounded."""
        files = []
        def strip(match):
            files.extend(line[2:].split(" (", 1)[0] for line in match.group(1).splitlines() if line.startswith("- "))
            return ""
        body = APP_FILES.sub(strip, text).strip()
        if files:
            note = ("\U0001f4ce " + ", ".join(files)) if self.attachments else "\U0001f4ce %d file(s) attached in the app" % len(files)
            body = (body + "\n\n" + note) if body else note
        if len(body) > WEB_TEXT_LIMIT:
            body = body[:WEB_TEXT_LIMIT].rstrip() + " \u2026"
        return body

    def discover_web(self):
        """Mirror owner messages typed in the V2 web UI to the group.

        Only snapshot rows the server marks `origin: "web"` qualify, and never a
        message this adapter admitted itself (no echo of WhatsApp input). The
        first scan of a ledger only records the current position."""
        cursor = self.ledger.web_cursor()
        if cursor is None:
            value = self.call("GET", "")
            if not isinstance(value, dict) or type(value.get("last_sequence")) is not int:
                raise Refused("snapshot_shape")
            self.ledger.set_web_cursor(value["last_sequence"])
            return
        own, identity = None, None
        for _ in range(WEB_PAGES):
            value = self.call("GET", "?after=%d&limit=%d" % (cursor, WEB_PAGE))
            rows = value.get("messages") if isinstance(value, dict) else None
            if not isinstance(rows, list) or len(rows) > WEB_PAGE:
                raise Refused("snapshot_shape")
            for row in rows:
                if (not isinstance(row, dict) or type(row.get("sequence")) is not int or row["sequence"] <= cursor or
                        not isinstance(row.get("message_id"), str) or not isinstance(row.get("text"), str)):
                    raise Refused("snapshot_shape")
                if row.get("origin") == "web" and row.get("actor_kind") == "owner" and row["text"].strip():
                    if own is None:
                        own = self.ledger.own_message_ids()
                    if row["message_id"] not in own:
                        uuid.UUID(row["message_id"])
                        if identity is None:
                            identity = self.provider_identity()
                        text = self.web_text(row["text"])
                        if text and self.ledger.enqueue_web(row, text, identity):
                            print("orkestr-v2-wa-adapter web_mirrored conversation=%s message=%s"
                                  % (getattr(self.client, "conversation", "?"), row["message_id"]),
                                  file=sys.stderr, flush=True)
                cursor = row["sequence"]
                self.ledger.set_web_cursor(cursor)
            if value.get("next_cursor") is None:
                break

    def web_dropped(self, watch, reason):
        self.ledger.drop_web_watch(watch["message_id"])
        print("orkestr-v2-wa-adapter web_answer_dropped conversation=%s message=%s reason=%s"
              % (getattr(self.client, "conversation", "?"), watch["message_id"], reason), file=sys.stderr, flush=True)

    def drive_web(self):
        """Deliver the accepted Deep answer of each mirrored web message.

        Never blocks the serial WhatsApp queue and never opens a window or
        accepts a run: the web UI (or owner auto-accept) does that. Runs are
        matched by the message's own source tuple and read by run ID."""
        for watch in self.ledger.web_watches(WEB_WATCHES_PER_PASS):
            try:
                self.drive_web_one(watch)
            except Refused as error:
                self.web_dropped(watch, str(error))
            except Exception:
                # Transient: retried at the next pass, bounded by WEB_ANSWER_MAX_S.
                if time.time() - watch.get("since", 0) > WEB_ANSWER_MAX_S:
                    self.web_dropped(watch, "answer_timeout")

    def drive_web_one(self, watch):
        now = time.time()
        if now - watch.get("since", now) > WEB_ANSWER_MAX_S:
            return self.web_dropped(watch, "answer_timeout")
        if "event_id" not in watch:
            first = self.client.read_events(after=watch["sequence"] - 1, maximum=1)
            event = first[0] if first else None
            if (not event or event.get("sequence") != watch["sequence"] or
                    (event.get("payload_ref_or_safe_payload") or {}).get("message_id") != watch["message_id"]):
                raise Refused("web_event_mismatch")
            watch.update(event_id=event["event_id"], cursor=watch["sequence"])
            self.ledger.save_web_watch(watch)
        intake = {"message_id": watch["message_id"], "event_id": watch["event_id"]}
        events = self.client.read_events(after=watch["cursor"], maximum=100)
        ids = set(watch.get("runs", [])) | set(self.client.matching_run_ids(events, intake))
        if len(ids) > 128:
            raise Refused("too_many_runs")
        watch["runs"] = sorted(ids)
        watch["cursor"] = max([watch["cursor"]] + [e["sequence"] for e in events])
        self.ledger.save_web_watch(watch)
        deep = []
        for run in watch["runs"]:
            status, value = self.client.request("GET", "/execution?run_id=" + run, allowed=(200, 404))
            if status == 200 and isinstance(value, dict) and value.get("run_id") == run:
                deep.append(value)
        done = [d for d in deep if d.get("phase") == "completed"]
        if done:
            return self.web_answer(watch, done[-1]["run_id"])
        live = [d for d in deep if d.get("phase") not in DEEP_TERMINAL_PHASES]
        for status in live:
            self.web_progress(watch, status)
        if live:
            return
        if deep:
            notice = policy_notice(deep[-1], ids)
            if notice:
                return self.ledger.complete_web(watch, notice["text"], notice)
            return self.web_dropped(watch, "deep_" + str(deep[-1].get("phase")))
        if len(events) == 100 or now - watch["since"] < WEB_NO_RUN_GRACE_S:
            return
        current = self.call("GET", "/window", allowed=(200, 204))
        if isinstance(current, dict) and current.get("state") != "closed":
            return
        self.web_dropped(watch, "no_run")

    def web_progress(self, watch, status):
        if not self.progress_updates or status.get("phase") != "running":
            return
        payload_id = (status.get("progress") or {}).get("payload_id")
        seen = watch.setdefault("progress", [])
        now = time.time()
        if (not payload_id or payload_id in seen or len(seen) >= PROGRESS_LIMIT or
                now - watch.get("progress_at", watch["since"]) < PROGRESS_INTERVAL_S):
            return
        payload = self.call("GET", "/payloads/" + payload_id)
        if payload.get("run_id") != status["run_id"] or payload.get("payload_id") != payload_id:
            raise Refused("progress_payload_mismatch")
        watch["progress_at"] = now
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip() or no_reply(text) or text.startswith(QUESTION_PREFIX):
            seen.append(payload_id)
            return self.ledger.save_web_watch(watch)
        if len(text) > PROGRESS_MAX_CHARS:
            text = text[:PROGRESS_MAX_CHARS].rstrip() + " \u2026"
        self.ledger.web_progress(watch, payload_id, text, self.provider_identity(run_id=status["run_id"], status=status))

    def web_answer(self, watch, run_id):
        after, rows = watch["sequence"], []
        for _ in range(10):
            history = self.call("GET", "/accepted-results?limit=50&after_sequence=" + str(after))
            rows.extend(r for r in history.get("results", []) if r.get("run_id") == run_id)
            cursor = history.get("next_after_sequence")
            if cursor is None or rows:
                break
            if type(cursor) is not int or cursor <= after:
                raise Refused("history_cursor")
            after = cursor
        if len(rows) != 1 or rows[0].get("payload_removed") is not False or not rows[0].get("payload_id"):
            # Completed without one canonical acceptance (for example rejected).
            raise Refused("not_accepted")
        payload = self.call("GET", "/payloads/" + rows[0]["payload_id"])
        if payload.get("run_id") != run_id or not isinstance(payload.get("text"), str):
            raise Refused("payload_mismatch")
        text = self.render_final(payload["text"])
        if text is None:
            return self.web_dropped(watch, "no_reply")
        self.ledger.complete_web(watch, text, self.provider_identity(run_id=run_id))

    def finish_digest(self, data):
        digest = data["digest"]
        text = self.render_final(digest["text"])
        if text is None:
            self.ledger.finish_silently(data, "suppressed")
            return
        reply = {"id": str(uuid.uuid5(DIGEST_REPLY_NAMESPACE, digest["id"])), "role": "assistant", "state": "completed",
                 "phase": "final_answer", "source": "rust-v2-pilot", "parentMessageId": data["remote_id"], "text": text}
        reply.update(self.provider_identity())
        self.ledger.complete(data, reply)

    def timer_window(self, data):
        """Server-queued Deep turn for a timer occurrence. Returns True to continue."""
        sequence = data["intake"]["sequence"]
        rows = [row for row in self.timer_inputs(sequence - 1, 1) if row["message_id"] == data["intake"]["message_id"]]
        if len(rows) != 1 or rows[0]["event_id"] != data["intake"]["event_id"] or rows[0]["request_key"] != data["keys"]["message"]:
            raise Refused("timer_input_mismatch")
        row = rows[0]
        if row.get("held"):
            # Disabled or handed back before it ran: Core will never execute it.
            self.ledger.finish_silently(data, "held")
            return False
        if row.get("window") == "queued":
            # Reading window status keeps the owner session current for the dispatcher.
            self.call("GET", "/window", allowed=(200, 204))
            if data.get("phase") != "waiting_for_timer_dispatch":
                data["phase"] = "waiting_for_timer_dispatch"
                self.ledger.save(data)
            return False
        if row.get("window") == "dispatched":
            data.update(window={"dispatched_by": "server_timer_queue"}, phase="running")
            self.ledger.save(data)
        # Withdrawn or never queued: open the window through the ordinary path.
        return True

    def gather_burst(self, data, now=None):
        """Decide, once, which queued inputs ride along with `data`.

        Returns False while the burst may still grow (wait for the next pass).
        Otherwise freezes the batch: every absorbed input's attachments are
        imported, the combined text is stored as `data`'s intake text, and the
        absorbed rows leave the queue in one ledger transaction."""
        if "intake" in data or "burst" in data or data.get("origin") or data.get("requeued") or data.get("continued"):
            return True
        rows = self.ledger.burst_candidates(data, BURST_MAX_INPUTS - 1)
        now = time.time() if now is None else now
        first = data.get("queued_at")
        if self.burst_quiet_s and isinstance(first, (int, float)):
            newest = max([first] + [r["queued_at"] for r in rows if isinstance(r.get("queued_at"), (int, float))])
            if now - newest < self.burst_quiet_s and now - first < max(BURST_MAX_WAIT_S, self.burst_quiet_s):
                # The next pass comes when the burst is due, not a whole pass later.
                self._burst_due = min(newest + self.burst_quiet_s, first + max(BURST_MAX_WAIT_S, self.burst_quiet_s))
                return False
        if data.get("attachments") and "attachment_receipt" not in data:
            self.import_attachments(data)
        texts, batch = [data.get("intake_text") or compose(data)], []
        for row in rows:
            try:
                if row.get("attachments") and "attachment_receipt" not in row:
                    self.import_attachments(row)
            except Exception:
                # This input runs on its own later; never fail the head for it.
                break
            text = row.get("intake_text") or compose(row)
            if len("\n\n".join(texts + [text]).encode()) > BURST_TEXT_MAX_BYTES:
                break
            texts.append(text)
            batch.append(row)
        if batch:
            data["intake_text"] = "\n\n".join([BURST_NOTE % len(texts)] + texts)
        self.ledger.absorb(data, batch)
        if batch:
            # Identifiers only, never message text.
            print("orkestr-v2-wa-adapter burst_merged conversation=%s input=%s absorbed=%d span_s=%.1f"
                  % (getattr(self.client, "conversation", "?"), data["remote_id"], len(batch),
                     max([0.0] + [r["queued_at"] - first for r in batch
                                  if isinstance(r.get("queued_at"), (int, float)) and isinstance(first, (int, float))])),
                  file=sys.stderr, flush=True)
        return True

    def step(self, data):
        if data.get("blocked"):
            return
        if data.get("digest"):
            return self.finish_digest(data)
        if not self.gather_burst(data):
            return
        if data.get("attachments") and "attachment_receipt" not in data:
            self.import_attachments(data)
        if "intake" not in data:
            text = data.get("intake_text") or compose(data)
            if data.get("origin") != "timer":
                text = self.with_rules(data, text)
            request = {"client_message_id": data["keys"]["message"], "text": text}
            if data.get("reply_to"):
                request["reply_to"] = data["reply_to"]
            if data.get("continued"):
                try:
                    request["expected_provider_generation"] = continuation_guard.generation(data)
                    request["continuation_source_run_id"] = data["continuation_guard"]["source_run_id"]
                except ValueError as error:
                    raise Refused(str(error)) from None
                status, intake = self.client.request("POST", "/messages", body=request, allowed=(200, 202, 409))
                if status == 409:
                    raise Refused("continuation_admission_requires_review")
            else:
                intake = self.call("POST", "/messages", request, (200, 202))
            if intake.get("status") != "accepted" or not all(intake.get(k) for k in ("message_id", "event_id", "sequence")):
                raise Refused("intake_receipt")
            data.update(intake=intake, cursor=intake["sequence"] - 1, phase="admitted", admitted_at=time.time())
            # Every Core message this adapter admitted is never mirrored back as web input.
            own = data.setdefault("own_messages", [])
            if intake["message_id"] not in own:
                own.append(intake["message_id"])
            self.ledger.save(data)
        self.fire_trigger(data)
        if data.get("origin") == "timer" and "window" not in data and "window_request" not in data:
            if not self.timer_window(data):
                return
        if "window" not in data:
            if "window_request" not in data:
                current = self.call("GET", "/window", allowed=(200, 204))
                if isinstance(current, dict) and current.get("state") in UNSETTLED_WINDOW_STATES:
                    # The previous window is still closing or awaits Core's
                    # reconciliation: nothing is frozen yet, so wait and retry.
                    if data.get("phase") != "waiting_for_window":
                        data["phase"] = "waiting_for_window"
                        self.ledger.save(data)
                    return
                data["previous_window"] = current
                data["window_request"] = self.client.window_request(data["intake"], data["keys"]["message"], data["keys"]["window"], current)
                self.ledger.save(data)
            status, reply = self.client.request("POST", "/window", body=data["window_request"], allowed=(200, 201, 202, 409))
            if status == 202:
                # Durably queued in Core (capacity, or a follow-up that would get
                # under ten minutes of work time): Core's dispatcher opens the
                # window later, possibly as a successor. Replays of the same
                # frozen request report the queue row until it is dispatched.
                if not self.window_queued(data, reply):
                    return
            elif status == 409:
                # A definite refusal is not authority to change the frozen request.
                # Busy windows may clear; stale tuples require operator review.
                code = reply.get("error", reply.get("code"))
                if isinstance(code, dict):
                    code = code.get("code")
                if code == "window_busy":
                    data["phase"] = "waiting_for_window"
                    self.ledger.save(data)
                    return
                raise Refused("window_refused")
            if status != 202:
                self.window_admitted(data, reply)
        self.observe(data)

    def window_queued(self, data, reply):
        """Track a Core-queued window request. Returns True once dispatched."""
        request = data["window_request"]
        if not isinstance(reply, dict) or any(reply.get(k) != request[k] for k in
                                              ("request_key", "input_message_id", "input_event_id", "input_request_key")):
            raise Refused("window_input_mismatch")
        state = reply.get("state")
        if state == "queued":
            if data.get("phase") != "waiting_for_window_dispatch":
                data["phase"] = "waiting_for_window_dispatch"
                self.ledger.save(data)
            return False
        if state != "dispatched" or not reply.get("window_id"):
            raise Refused("window_withdrawn")
        data.update(window={"dispatched_by": "server_window_queue", "window_id": reply["window_id"]}, phase="running")
        self.ledger.save(data)
        return True

    def window_admitted(self, data, reply):
        request, window = data["window_request"], reply.get("status", {})
        generation = request["expected_generation"] + (0 if request["window_id"] else 1)
        predecessor = ((data.get("previous_window") or {}).get("predecessor_window_id")
                       if request["window_id"] else request["predecessor_window_id"])
        if (any(reply.get(k) != request[k] for k in ("request_key", "input_message_id", "input_event_id", "input_request_key")) or
            window.get("conversation_id") != self.client.conversation or window.get("state") not in ("opening", "active") or
            window.get("generation") != generation or
            (request["window_id"] is not None and window.get("window_id") != request["window_id"]) or
            window.get("predecessor_window_id") != predecessor):
            raise Refused("window_input_mismatch")
        data.update(window=reply, phase="running")
        self.ledger.save(data)

    def observe(self, data):
        if "window" not in data:
            return
        events = self.client.read_events(after=data["cursor"], maximum=100)
        # The client returns only complete validated envelopes. Advance the cursor
        # together with the exact source tuple's run IDs, before reading statuses.
        ids = set(data.get("matched_runs", [])) | set(self.client.matching_run_ids(events, data["intake"]))
        if len(ids) > 128:
            raise Refused("too_many_runs")
        data["matched_runs"] = sorted(ids)
        data["cursor"] = max([data["cursor"]] + [event["sequence"] for event in events])
        self.ledger.save(data)
        self.capture_questions(data, events, ids)
        if data.get("origin") == "timer":
            # Timer occurrences queue behind each other, so this input's runs
            # are often no longer the conversation's current ones: read them
            # by run ID, never through the current view.
            statuses = self.own_statuses(ids)
            if self.timer_without_deep(data, statuses, caught_up=len(events) < 100):
                return
        else:
            statuses = {role: self.call("GET", route, allowed=(200, 204)) for role, route in
                        (("fast", "/fast/execution"), ("deep", "/execution"))}
        notice = policy_notice(statuses["deep"], ids)
        if notice:
            self.settle_own_fast(data, statuses.get("fast"), ids)
            self.ledger.refuse(data, "provider_policy_refusal", alert=data.get("origin") == "timer", notice=notice)
            return
        capture_first_response(self, data, statuses, ids)
        self.capture_progress(data, statuses["deep"], ids)
        accepted = data.setdefault("accepted", {})
        if self.continue_after_deadline(data, statuses, ids):
            return
        self.refuse_orphaned(data, ids)
        for role, value in statuses.items():
            if role in accepted or role + "_accept_request" in data:
                continue
            if self.accepted_elsewhere(value, ids):
                # The server accepted this input's own proposal (owner
                # auto-accept): adopt that receipt below, never refuse.
                continue
            if role == "fast" and self.fast_unusable(value, ids):
                # A Fast that is gone, failed or stranded never holds the Deep
                # reply: wait for Deep, then skip Fast after a short grace.
                if not self.skip_fast(data, statuses.get("deep"), ids):
                    return
                continue
            if not value or value.get("run_id") not in ids:
                return
            if value.get("phase") in ("failed", "lost", "cancelled", "blocked", "stopped", "interrupted", "completed"):
                self.settle_own_fast(data, statuses.get("fast"), ids)
                raise Refused("execution_requires_review")
            if value.get("phase") != "awaiting_acceptance":
                return
        # Wait for both proposals before accepting either. This avoids a sibling
        # revision race and never automatically accepts another browser input.
        for role in ("fast", "deep"):
            if role not in accepted:
                self.accept_role(data, role, ids)
        # Confirm the canonical accepted-results view, including frozen payload.
        deep = accepted["deep"]
        matches, after = [], data["intake"]["sequence"]
        for _ in range(10):
            history = self.call("GET", "/accepted-results?limit=50&after_sequence=" + str(after))
            matches.extend(row for row in history.get("results", []) if row.get("acceptance_event_id") == deep["acceptance_event_id"])
            cursor = history.get("next_after_sequence")
            if cursor is None or matches:
                break
            if type(cursor) is not int or cursor <= after:
                raise Refused("history_cursor")
            after = cursor
        if len(matches) != 1 or matches[0].get("payload_removed") is not False or any(matches[0].get(k) != deep[k] for k in ("run_id", "completion_event_id")) or matches[0].get("payload_id") != data["deep_payload"]["payload_id"]:
            raise Refused("accepted_history_mismatch")
        text = self.timer_final(data, data["deep_payload"]["text"])
        reply = {"id": deep["acceptance_event_id"], "role": "assistant", "state": "completed",
                 "phase": "final_answer", "source": "rust-v2-pilot", "parentMessageId": data["remote_id"], "text": text}
        reply.update(self.provider_identity(run_id=deep["run_id"]))
        if text is None:
            # V1 never transports an exact NO_REPLY; it acknowledges it as no_reply.
            reply.update(text="NO_REPLY", noReply=True)
        self.ledger.complete(data, reply)

    def own_statuses(self, ids):
        """Status of this input's own Fast and Deep runs, looked up by run ID
        (a run of the other role answers 404). Missing roles are None."""
        found = {"fast": None, "deep": None}
        for run in sorted(ids):
            for role, route in (("deep", "/execution"), ("fast", "/fast/execution")):
                if found[role] is not None:
                    continue
                status, value = self.client.request("GET", "%s?run_id=%s" % (route, run), allowed=(200, 404))
                if status == 200 and isinstance(value, dict) and value.get("run_id") == run:
                    found[role] = value
                    break
        return found

    def timer_without_deep(self, data, statuses, caught_up):
        """Whether a timer input with no Deep run of its own must keep waiting.

        A timer occurrence is never re-sent, so an input whose window ended
        before its Deep turn ran would otherwise stay open forever and hold
        every later input of the binding behind it. While the conversation
        still has an unclosed window the run may yet start (a window past its
        deadline is a genuine stall and is alerted by the stall check); once
        every window is closed it is refused with an operator alert.
        Returns True to wait, False when a Deep run exists.
        """
        if isinstance(statuses.get("deep"), dict):
            data.pop("deep_missing_since", None)
            return False
        now = time.time()
        since = data.setdefault("deep_missing_since", now)
        if since == now:
            self.ledger.save(data)
        if not caught_up or now - since < ORPHAN_GRACE_S:
            return True
        current = self.call("GET", "/window", allowed=(200, 204))
        if isinstance(current, dict) and current.get("state") != "closed":
            return True
        if self.timer_requeued(data):
            # Core queued the occurrence again after its window failed to open
            # (nothing of it ran): wait for the retry window's Deep run.
            data["deep_missing_since"] = now
            if data.get("phase") != "waiting_for_timer_retry":
                data["phase"] = "waiting_for_timer_retry"
            self.ledger.save(data)
            return True
        raise Refused("timer_window_ended_without_run")

    def timer_requeued(self, data):
        """Whether Core put this timer occurrence back in its window queue."""
        sequence = data["intake"]["sequence"]
        rows = [row for row in self.timer_inputs(sequence - 1, 1) if row["message_id"] == data["intake"]["message_id"]]
        return len(rows) == 1 and rows[0]["event_id"] == data["intake"]["event_id"] and rows[0].get("window") == "queued"

    def role_status(self, data, role, ids):
        if data.get("origin") == "timer":
            return self.own_statuses(ids)[role]
        return self.call("GET", "/fast/execution" if role == "fast" else "/execution")

    @staticmethod
    def fast_unusable(value, ids):
        return (not value or value.get("run_id") not in ids or
                value.get("phase") in FAST_UNUSABLE_PHASES)

    @staticmethod
    def accepted_elsewhere(value, ids):
        """This input's own run already accepted (by the server's owner
        auto-accept or the owner's browser); its receipt is adopted."""
        return isinstance(value, dict) and value.get("run_id") in ids and value.get("phase") == "completed"

    def skip_fast(self, data, deep, ids):
        """Skip this input's unusable Fast once its Deep proposal is ready."""
        if (not isinstance(deep, dict) or deep.get("run_id") not in ids or
                deep.get("phase") not in ("awaiting_acceptance", "completed")):
            return False
        now = time.time()
        if "fast_unusable_since" not in data:
            data["fast_unusable_since"] = now
            self.ledger.save(data)
        if now - data["fast_unusable_since"] < FAST_GRACE_S:
            return False
        data["accepted"]["fast"] = {"skipped": "fast_unavailable", "at": now}
        self.ledger.save(data)
        return True

    def accept_role(self, data, role, ids):
        """Freeze, then accept, this input's own proposal of one role."""
        accepted = data.setdefault("accepted", {})
        frozen_key = role + "_accept_request"
        if frozen_key not in data:
            value = self.role_status(data, role, ids) or {}
            if self.accepted_elsewhere(value, ids):
                self.adopt_acceptance(data, role, value["run_id"], ids)
                return
            if value.get("run_id") not in ids or value.get("phase") != "awaiting_acceptance":
                raise Refused("proposal_replaced")
            candidate = value.get("acceptance_candidate", {})
            payload_id = (value.get("progress") or {}).get("payload_id")
            if candidate.get("run_id") != value["run_id"] or not payload_id:
                raise Refused("proposal_shape")
            payload = self.call("GET", "/payloads/" + payload_id)
            if payload.get("run_id") != value["run_id"] or payload.get("payload_id") != payload_id or not isinstance(payload.get("text"), str) or not payload["text"].strip():
                raise Refused("payload_mismatch")
            data[role + "_payload"] = payload
            data[frozen_key] = {"run_id": value["run_id"], "completion_event_id": candidate["completion_event_id"],
                                "expected_revision": value["revision"], "request_key": data["keys"][role]}
            self.ledger.save(data)
        request = data[frozen_key]
        try:
            receipt = self.call("POST", "/accept", request)
        except ClientError as error:
            if error.status != 409:
                raise
            # The server may have accepted this same run first (owner
            # auto-accept); a conflict for any other reason still refuses.
            self.adopt_acceptance(data, role, request["run_id"], ids)
            return
        if receipt.get("outcome") != "succeeded" or any(receipt.get(k) != request[k] for k in ("run_id", "completion_event_id", "request_key")) or receipt.get("requested_revision") != request["expected_revision"] or not receipt.get("acceptance_event_id"):
            raise Refused("acceptance_receipt")
        accepted[role] = receipt
        self.ledger.save(data)

    def adopt_acceptance(self, data, role, run_id, ids):
        """Record the canonical acceptance of this input's own run, made by
        the server (owner auto-accept) before this adapter's own request."""
        if run_id not in ids:
            raise Refused("proposal_replaced")
        frozen = data.get(role + "_accept_request")
        if frozen is not None and frozen.get("run_id") != run_id:
            raise Refused("proposal_replaced")
        after, rows = data["intake"]["sequence"], []
        for _ in range(10):
            history = self.call("GET", "/accepted-results?limit=50&after_sequence=" + str(after))
            rows.extend(row for row in history.get("results", []) if row.get("run_id") == run_id)
            cursor = history.get("next_after_sequence")
            if cursor is None or rows:
                break
            if type(cursor) is not int or cursor <= after:
                raise Refused("history_cursor")
            after = cursor
        if not rows:
            # Completed without an acceptance: not ours to mirror.
            raise Refused("execution_requires_review")
        if len(rows) != 1:
            raise Refused("acceptance_receipt")
        row = rows[0]
        if (not all(isinstance(row.get(k), str) and row[k] for k in ("acceptance_event_id", "completion_event_id")) or
                (frozen is not None and row["completion_event_id"] != frozen["completion_event_id"])):
            raise Refused("acceptance_receipt")
        # Only the Deep reply is mirrored, so only its payload is frozen here.
        if role == "deep" and "deep_payload" not in data:
            payload_id = row.get("payload_id")
            if not payload_id or row.get("payload_removed") is not False:
                raise Refused("payload_mismatch")
            payload = self.call("GET", "/payloads/" + payload_id)
            if (payload.get("run_id") != run_id or payload.get("payload_id") != payload_id or
                    not isinstance(payload.get("text"), str) or not payload["text"].strip()):
                raise Refused("payload_mismatch")
            data[role + "_payload"] = payload
        data.setdefault("accepted", {})[role] = {
            "outcome": "succeeded", "run_id": run_id, "completion_event_id": row["completion_event_id"],
            "acceptance_event_id": row["acceptance_event_id"], "adopted": True}
        self.ledger.save(data)

    def deadline_stopped(self, data):
        """Whether this input's window ran out of work time (not an owner stop)."""
        window = data.get("window") or {}
        own = (window.get("status") or {}).get("window_id") or window.get("window_id")
        current = self.call("GET", "/window", allowed=(200, 204))
        if not isinstance(current, dict) or (own is not None and current.get("window_id") != own):
            return False
        if current.get("state") in ("retiring", "closed"):
            return True
        deadline = current.get("work_deadline_ms")
        return (current.get("state") == "active" and type(deadline) is int and
                deadline <= time.time() * 1000)

    def settle_own_fast(self, data, fast, ids):
        """Before refusing an input, accept its own pending Fast proposal so the
        window is not held open for an answer nobody will accept."""
        if (isinstance(fast, dict) and fast.get("run_id") in ids and fast.get("phase") == "awaiting_acceptance"
                and "fast" not in data.get("accepted", {})):
            try:
                self.accept_role(data, "fast", ids)
            except Exception:
                pass

    def window_ended(self, data):
        """Whether this input's window is over: closed or retiring, past its work
        deadline, replaced by another window, or no window exists any more."""
        window = data.get("window") or {}
        own = (window.get("status") or {}).get("window_id") or window.get("window_id")
        current = self.call("GET", "/window", allowed=(200, 204))
        if not isinstance(current, dict) or (own is not None and current.get("window_id") != own):
            return True
        if current.get("state") in ("retiring", "closed"):
            return True
        deadline = current.get("work_deadline_ms")
        return (current.get("state") == "active" and type(deadline) is int and
                deadline <= time.time() * 1000)

    def refuse_orphaned(self, data, ids):
        """Settle an unstarted input after its window ends; never clone intake.

        Re-admitting with new message keys hides setup failure behind duplicate
        owner messages. Preserve the original evidence and use the normal
        failure notice/settlement path so later inputs can proceed. Timers keep
        their separate Core-owned retry of the same occurrence.
        """
        if ids or data.get("origin") == "timer" or "window" not in data:
            return False
        now = time.time()
        since = data.setdefault("unstarted_since", now)
        if since == now:
            self.ledger.save(data)
        if now - since < ORPHAN_GRACE_S or not self.window_ended(data):
            return False
        raise Refused("window_setup_failed")

    def continue_after_deadline(self, data, statuses, ids):
        """Re-queue an input once when a window deadline stopped its Deep turn.

        The owner's message is never dropped silently: it is sent again as a
        new turn of the same conversation, which resumes the same native
        session in the successor window, and the owner is told so. A second
        deadline stop, an owner stop or any other failure still refuses.
        Returns True when the input was re-queued.
        """
        deep = statuses.get("deep")
        if ("deep" in data.get("accepted", {}) or "deep_accept_request" in data or data.get("continued") or
                data.get("origin") == "timer" or not isinstance(deep, dict) or deep.get("run_id") not in ids or
                deep.get("phase") not in DEADLINE_STOP_PHASES or not self.deadline_stopped(data)):
            return False
        try:
            guard = continuation_guard.freeze(self.call, deep)
        except ValueError as error:
            raise Refused(str(error)) from None
        fast = statuses.get("fast")
        if (isinstance(fast, dict) and fast.get("run_id") in ids and fast.get("phase") == "awaiting_acceptance" and
                "fast" not in data.get("accepted", {})):
            try:
                # This input's own short reply; accepting it lets its window close.
                self.accept_role(data, "fast", ids)
            except Exception:
                pass
        text = data.get("intake_text") or compose(data)
        previous = data["intake"]["message_id"]
        for key in RESET_KEYS:
            data.pop(key, None)
        for key in ("message", "window", "fast", "deep"):
            data["keys"][key] = str(uuid.uuid4())
        data.update(intake_text=CONTINUE_PREFIX + text, phase="queued", queued_at=time.time(),
                    continued={"previous_message_id": previous, "at": time.time()}, continuation_guard=guard)
        self.ledger.continue_notice(data, CONTINUE_NOTICE)
        return True

    def provider_identity(self, run_id=None, status=None, fast=False):
        """Exact-run evidence for footers; unknown models remain unreported."""
        return observed_identity(self.call, run_id=run_id, status=status, fast=fast)

    def render_final(self, text):
        """Apply the conversation's reply settings (NO_REPLY, prefix, footer)
        through Rust's canonical `settings/render`; None means silent.

        A server without the route (404) keeps the V1 NO_REPLY rule only.
        """
        try:
            value = self.call("POST", "/settings/render", {"text": text})
        except ClientError as error:
            if error.status != 404:
                raise
            return None if no_reply(text) or not text.strip() else text
        outcome = value.get("outcome") if isinstance(value, dict) else None
        if outcome == "suppressed" and value.get("reason") in ("no_reply", "empty"):
            return None
        if outcome != "deliver" or not isinstance(value.get("text"), str) or not value["text"].strip() or no_reply(value["text"]):
            raise Refused("render_shape")
        return value["text"]

    def run(self, stop, active=lambda: True):
        pause = PASS_S
        while not stop.wait(pause):
            # Expiry only touches the ledger, so it also runs while the binding
            # is paused: a re-enabled binding never runs stale input.
            self.expire_stale()
            if not active():
                pause = IDLE_PASS_S
            elif self.run_once(stop):
                pause = self.busy_pause()
            else:
                pause = self.idle_pause()

    def busy_pause(self, now=None):
        """PASS_S, or less when a waiting burst head becomes due sooner. A new
        message of the burst wakes the worker anyway and restarts the wait."""
        due, self._burst_due = self._burst_due, None
        if due is None:
            return PASS_S
        now = time.time() if now is None else now
        return min(PASS_S, max(0.05, due - now))

    def idle_pause(self, now=None):
        """Seconds until the next Rust poll is due, between PASS_S and IDLE_PASS_S."""
        now = time.monotonic() if now is None else now
        due = [checked + interval - now for checked, interval in
               ((self._timers_checked, TIMER_POLL_S), (self._posts_checked, POST_POLL_S),
                (self._digest_checked, DIGEST_POLL_S)) if checked is not None]
        if self.web_mirror and self._web_checked is not None:
            due.append(self._web_checked + WEB_POLL_S - now)
        return max(PASS_S, min([IDLE_PASS_S] + due))

    @staticmethod
    def _due(checked, interval):
        # A pause ends at the due time; a few ms of early wakeup still counts.
        return checked is None or time.monotonic() - checked >= interval - 0.05

    def expire_stale(self):
        try:
            self.ledger.expire_stale(self.max_input_age_s)
        except Exception:
            # Retried every pass; never blocks the binding.
            pass

    def run_once(self, stop):
        """One pass. Returns True while an input is pending (step again soon)."""
        if self._due(self._timers_checked, TIMER_POLL_S):
            self._timers_checked = time.monotonic()
            try:
                self.discover_timers()
            except Exception:
                # Discovery is retried at the next check; it never blocks existing inputs.
                pass
        # Digests are due a few times a day: look every DIGEST_POLL_S, not every pass.
        if self._due(self._digest_checked, DIGEST_POLL_S):
            self._digest_checked = time.monotonic()
            try:
                self.discover_digests()
            except Exception:
                # A missing route (older server) or a failure is retried at the next check.
                pass
        # Posts are interactive: look every POST_POLL_S. A paused binding (run()
        # skips run_once) leaves them pending in Rust until it is enabled again.
        if self._due(self._posts_checked, POST_POLL_S):
            self._posts_checked = time.monotonic()
            try:
                self.discover_posts()
            except Exception:
                # A missing route (older server) or a failure is retried at the next check.
                pass
        # Web-UI owner messages: interactive, never queued behind WhatsApp input.
        if self.web_mirror and self._due(self._web_checked, WEB_POLL_S):
            self._web_checked = time.monotonic()
            try:
                self.discover_web()
            except Exception:
                pass
            try:
                self.drive_web()
            except Exception:
                pass
        try:
            for data in self.ledger.mark_stalled(STALL_NOTICE_AFTER_S, STALL_NOTICE):
                print("ALERT orkestr-v2-wa-adapter input_stalled conversation=%s input=%s phase=%s age_min=%d"
                      % (getattr(self.client, "conversation", "?"), data["remote_id"], data.get("phase"),
                         (data["stalled"]["at"] - data["stalled"]["since"]) // 60),
                      file=sys.stderr, flush=True)
        except Exception:
            # Retried every pass; never blocks the binding.
            pass
        data = self.ledger.next_input()
        if not data:
            return False
        if data.get("blocked"):
            # Written by an earlier adapter version: close it visibly so the
            # inputs behind it proceed.
            self.ledger.refuse(data, data["blocked"])
            return True
        try:
            self.step(data)
        except Refused as error:
            # A definite refusal is terminal for this input only: the owner gets
            # a notice and later inputs proceed. Health keeps it for review.
            # A timer occurrence has no sender who could resend it, so its
            # refusal (a failed, lost or never started run) also alerts the operator.
            timer = data.get("origin") == "timer"
            if self.ledger.refuse(data, str(error), alert=timer) and timer:
                print("ALERT orkestr-v2-wa-adapter input_failed conversation=%s input=%s phase=%s reason=%s"
                      % (getattr(self.client, "conversation", "?"), data["remote_id"],
                         data["refused"].get("phase"), data["refused"]["reason"]),
                      file=sys.stderr, flush=True)
        except Exception as error:
            # Transient failures retry the same frozen request (bounded by the
            # input age limit until a window is open). Definite upstream
            # refusals are terminal like any other refusal.
            if not transient(error):
                self.ledger.refuse(data, refusal_reason(error), alert=data.get("origin") == "timer")
            elif getattr(error, "code", None) == "session_revoked" and not self._revoked_alerted:
                # Retried, but never silently: nothing reaches Rust until an
                # operator restores the owner session.
                self._revoked_alerted = True
                print("ALERT orkestr-v2-wa-adapter session_revoked conversation=%s input=%s"
                      % (getattr(self.client, "conversation", "?"), data["remote_id"]),
                      file=sys.stderr, flush=True)
            stop.wait(4)
        return True
