"""Serial, restart-safe Rust intake for one binding. Only the matched Deep run is mirrored."""
import time
import uuid

from .ledger import PROGRESS_LIMIT, no_reply
from .rust_client import ClientError

PROGRESS_INTERVAL_S = 60
PROGRESS_MAX_CHARS = 3500
TIMER_PAGE = 50


class Refused(RuntimeError):
    """A safety condition requires operator reconciliation, never silent replay."""


def attachment_note(text, manifest_id, references):
    lines = ["[WhatsApp attachments imported into this conversation's attachment store, manifest %s:" % manifest_id]
    lines += ["- %s (%s, %d bytes, reference %s)" % (r["filename"], r["media_type"], r["byte_length"], r["reference_id"])
              for r in references]
    return (text.rstrip() + "\n\n" if text.strip() else "") + "\n".join(lines) + "]"


class Worker:
    def __init__(self, client, ledger, progress_updates=False):
        self.client, self.ledger = client, ledger
        self.progress_updates = progress_updates

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
        contents = []
        for item, ref in zip(data["attachments"], request["source"]["manifest"]["references"]):
            content = self.ledger.upload_bytes(item["upload_id"])
            if content is None:
                raise Refused("attachment_bytes_missing")
            contents.append({"reference_id": ref["reference_id"], "bytes": list(content)})
        request["source"] = dict(request["source"], contents=contents)
        receipt = self.client.import_attachments(request)
        target = request["target_manifest"]
        data["attachment_receipt"] = {"import_id": receipt["import_id"], "manifest_id": target["manifest_id"]}
        data["intake_text"] = attachment_note(data["text"], target["manifest_id"], target["references"])
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
            text = data.get("intake_text", data["text"])
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
                data["previous_window"] = current
                data["window_request"] = self.client.window_request(data["intake"], data["keys"]["message"], data["keys"]["window"], current)
                self.ledger.save(data)
            status, reply = self.client.request("POST", "/window", body=data["window_request"], allowed=(200, 201, 409))
            if status == 409:
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
        for role, value in statuses.items():
            if role in accepted or role + "_accept_request" in data:
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
            if role in accepted:
                continue
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
        if text is None:
            # V1 never transports an exact NO_REPLY; it acknowledges it as no_reply.
            reply.update(text="NO_REPLY", noReply=True)
        self.ledger.complete(data, reply)

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
            if active():
                self.run_once(stop)

    def run_once(self, stop):
        try:
            self.discover_timers()
        except Exception:
            # Discovery is retried every pass; it never blocks existing inputs.
            pass
        data = self.ledger.next_input()
        if not data:
            return
        try:
            self.step(data)
        except Refused as error:
            data["blocked"] = str(error)
            data["phase"] = "blocked"
            self.ledger.save(data)
        except Exception as error:
            # Only transport failures have an automatic retry path. Preserve
            # immutable POST keys when the commit outcome is unknown.
            code = getattr(error, "code", None)
            if code is not None and code not in ("transport_failed", "transport_outcome_unknown"):
                data["blocked"] = "upstream_refused"
                data["phase"] = "blocked"
                self.ledger.save(data)
            stop.wait(4)
