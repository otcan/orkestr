"""Serial, restart-safe Rust intake. Only a matched accepted Deep result is mirrored."""


class Refused(RuntimeError):
    """A safety condition requires operator reconciliation, never silent replay."""


class Worker:
    def __init__(self, client, ledger):
        self.client, self.ledger = client, ledger

    def call(self, method, route, body=None, allowed=(200,)):
        return self.client.request(method, route, body=body, allowed=allowed)[1]

    def step(self, data):
        if data.get("blocked"):
            return
        if "intake" not in data:
            intake = self.call("POST", "/messages", {"client_message_id": data["keys"]["message"], "text": data["text"]}, (200, 202))
            if intake.get("status") != "accepted" or not all(intake.get(k) for k in ("message_id", "event_id", "sequence")):
                raise Refused("intake_receipt")
            data.update(intake=intake, cursor=intake["sequence"] - 1, phase="admitted")
            self.ledger.save(data)
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
        data["reply"] = {"id": deep["acceptance_event_id"], "role": "assistant", "state": "completed",
                         "phase": "final_answer", "source": "rust-v2-pilot", "parentMessageId": data["remote_id"],
                         "text": data["deep_payload"]["text"]}
        data["phase"] = "completed"
        self.ledger.save(data)

    def run(self, stop):
        while not stop.wait(1):
            data = self.ledger.next_input()
            if not data:
                continue
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
