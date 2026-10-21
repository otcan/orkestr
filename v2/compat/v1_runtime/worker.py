"""Serial, restart-safe Rust intake for one binding. Only the matched Deep run is mirrored."""
import grp
import os
from pathlib import Path
import re
import sys
import time
import uuid

from .ledger import DEFAULT_MAX_INPUT_AGE_S, PROGRESS_LIMIT, no_reply
from .participants import compose
from .rust_client import ClientError

PROGRESS_INTERVAL_S = 60
PROGRESS_MAX_CHARS = 3500
TIMER_PAGE = 50
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


class Worker:
    def __init__(self, client, ledger, progress_updates=False, max_input_age_s=DEFAULT_MAX_INPUT_AGE_S,
                 attachment_dir=None, attachment_gid=None):
        self.client, self.ledger = client, ledger
        self.attachment_dir, self.attachment_gid = attachment_dir, attachment_gid
        self.progress_updates = progress_updates
        self.max_input_age_s = max_input_age_s

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
        self.ledger.add_progress(data, payload_id, text)

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

    def step(self, data):
        if data.get("blocked"):
            return
        if data.get("attachments") and "attachment_receipt" not in data:
            self.import_attachments(data)
        if "intake" not in data:
            text = data.get("intake_text") or compose(data)
            intake = self.call("POST", "/messages", {"client_message_id": data["keys"]["message"], "text": text}, (200, 202))
            if intake.get("status") != "accepted" or not all(intake.get(k) for k in ("message_id", "event_id", "sequence")):
                raise Refused("intake_receipt")
            data.update(intake=intake, cursor=intake["sequence"] - 1, phase="admitted", admitted_at=time.time())
            self.ledger.save(data)
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
        statuses = {role: self.call("GET", route, allowed=(200, 204)) for role, route in
                    (("fast", "/fast/execution"), ("deep", "/execution"))}
        self.capture_progress(data, statuses["deep"], ids)
        accepted = data.setdefault("accepted", {})
        if self.continue_after_deadline(data, statuses, ids):
            return
        for role, value in statuses.items():
            if role in accepted or role + "_accept_request" in data:
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
        text = self.render_final(data["deep_payload"]["text"])
        reply = {"id": deep["acceptance_event_id"], "role": "assistant", "state": "completed",
                 "phase": "final_answer", "source": "rust-v2-pilot", "parentMessageId": data["remote_id"], "text": text}
        reply.update(self.provider_identity())
        if text is None:
            # V1 never transports an exact NO_REPLY; it acknowledges it as no_reply.
            reply.update(text="NO_REPLY", noReply=True)
        self.ledger.complete(data, reply)

    @staticmethod
    def fast_unusable(value, ids):
        return (not value or value.get("run_id") not in ids or
                value.get("phase") in FAST_UNUSABLE_PHASES)

    def skip_fast(self, data, deep, ids):
        """Skip this input's unusable Fast once its Deep proposal is ready."""
        if not isinstance(deep, dict) or deep.get("run_id") not in ids or deep.get("phase") != "awaiting_acceptance":
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
            route = "/fast/execution" if role == "fast" else "/execution"
            value = self.call("GET", route)
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
        receipt = self.call("POST", "/accept", request)
        if receipt.get("outcome") != "succeeded" or any(receipt.get(k) != request[k] for k in ("run_id", "completion_event_id", "request_key")) or receipt.get("requested_revision") != request["expected_revision"] or not receipt.get("acceptance_event_id"):
            raise Refused("acceptance_receipt")
        accepted[role] = receipt
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
        for key in ("intake", "cursor", "window", "window_request", "previous_window", "matched_runs", "accepted",
                    "fast_accept_request", "deep_accept_request", "fast_payload", "deep_payload", "admitted_at",
                    "progress_at"):
            data.pop(key, None)
        for key in ("message", "window", "fast", "deep"):
            data["keys"][key] = str(uuid.uuid4())
        data.update(intake_text=CONTINUE_PREFIX + text, phase="queued", queued_at=time.time(),
                    continued={"previous_message_id": previous, "at": time.time()})
        self.ledger.continue_notice(data, CONTINUE_NOTICE)
        return True

    def provider_identity(self):
        """Provider and model of the conversation, for the V1 debug footer.
        Best effort: a missing route or odd shape only omits the fields."""
        try:
            value = self.call("GET", "/settings")
        except Exception:
            return {}
        if not isinstance(value, dict):
            return {}
        identity = {}
        for key in ("provider", "model"):
            item = value.get(key)
            if isinstance(item, str) and re.fullmatch("[A-Za-z0-9._:-]{1,64}", item):
                identity[key] = item
        return identity if "provider" in identity else {}

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
        while not stop.wait(1):
            # Expiry only touches the ledger, so it also runs while the binding
            # is paused: a re-enabled binding never runs stale input.
            self.expire_stale()
            if active():
                self.run_once(stop)

    def expire_stale(self):
        try:
            self.ledger.expire_stale(self.max_input_age_s)
        except Exception:
            # Retried every pass; never blocks the binding.
            pass

    def run_once(self, stop):
        try:
            self.discover_timers()
        except Exception:
            # Discovery is retried every pass; it never blocks existing inputs.
            pass
        try:
            for data in self.ledger.mark_stalled(STALL_NOTICE_AFTER_S, STALL_NOTICE):
                print("ALERT orkestr-v2-wa-adapter input_stalled conversation=%s input=%s phase=%s"
                      % (getattr(self.client, "conversation", "?"), data["remote_id"], data.get("phase")),
                      file=sys.stderr, flush=True)
        except Exception:
            # Retried every pass; never blocks the binding.
            pass
        data = self.ledger.next_input()
        if not data:
            return
        if data.get("blocked"):
            # Written by an earlier adapter version: close it visibly so the
            # inputs behind it proceed.
            self.ledger.refuse(data, data["blocked"])
            return
        try:
            self.step(data)
        except Refused as error:
            # A definite refusal is terminal for this input only: the owner gets
            # a notice and later inputs proceed. Health keeps it for review.
            self.ledger.refuse(data, str(error))
        except Exception as error:
            # Transient failures retry the same frozen request (bounded by the
            # input age limit until a window is open). Definite upstream
            # refusals are terminal like any other refusal.
            if not transient(error):
                self.ledger.refuse(data, refusal_reason(error))
            stop.wait(4)
