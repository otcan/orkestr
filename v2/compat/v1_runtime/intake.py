"""Authenticated immutable intake and ordinary execution-window admission."""
import time

from . import continuation_guard
from .participants import compose


# Stored author role -> Core's verified input author. Only "owner" may command
# a thread ask; a burst only ever merges inputs of one author.
AUTHOR_FEATURE = "message_author"
AUTHORS = {"owner": "owner", "member": "member", "v1_owner": "v1_owner", "v1_agent": "v1_agent",
           "v1_external": "v1_external"}


def author_supported(client):
    """Whether the server advertises `message_author`. Before the first
    identity check of this process, one (cached) check reads it."""
    features = getattr(client, "features", None)
    if features is None:
        return False
    if not features and hasattr(client, "ensure_login"):
        client.ensure_login(mutation=False)
        features = client.features
    return AUTHOR_FEATURE in features


def verified_author(data):
    """The author this adapter verified for a chat or V1-local input, else None
    (timer, digest and post rows have no human author)."""
    if data.get("origin"):
        return None
    return AUTHORS.get((data.get("author") or {}).get("role"))


def with_quoted_id(text, reply_to):
    """Add the quoted message's id to the visible `[Replying to …]` line, so the
    model can look up a quoted message by id (e.g. `orkestr-provenance <id>`
    when the owner asks where a system message came from). Same line, so the
    UI still hides it with the quote; nothing changes without a reply line."""
    message_id = (reply_to or {}).get("message_id")
    if not message_id or not isinstance(text, str):
        return text
    marker = "[quoted message id: %s]" % message_id
    if marker in text:
        return text
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if line.startswith("[Replying to ") and line.endswith("]"):
            lines[index] = line + " " + marker
            return "\n".join(lines)
    return text


def admit(worker, data, merge_burst=True):
    """Freeze and admit one source through the existing owner HTTP surface."""
    from .worker import Refused
    if merge_burst:
        if not worker.gather_burst(data):
            return False
    elif "burst" not in data:
        # Freeze individual admission before I/O, including an uncertain POST.
        data["burst"] = []
        worker.ledger.save(data)
    if data.get("attachments") and "attachment_receipt" not in data:
        worker.import_attachments(data)
    if "intake" not in data:
        text = with_quoted_id(data.get("intake_text") or compose(data), data.get("reply_to"))
        if data.get("origin") != "timer":
            text = worker.with_rules(data, text)
        request = {"client_message_id": data["keys"]["message"], "text": text}
        author = verified_author(data)
        if author and author_supported(worker.client):
            # Only to a server that accepts it: its body refuses unknown fields.
            request["author"] = author
        if data.get("reply_to"):
            request["reply_to"] = data["reply_to"]
        if data.get("continued"):
            try:
                request["expected_provider_generation"] = continuation_guard.generation(data)
                request["continuation_source_run_id"] = data["continuation_guard"]["source_run_id"]
            except ValueError as error:
                raise Refused(str(error)) from None
            status, intake = worker.client.request("POST", "/messages", body=request, allowed=(200, 202, 409))
            if status == 409:
                raise Refused("continuation_admission_requires_review")
        else:
            intake = worker.call("POST", "/messages", request, (200, 202))
        if intake.get("status") != "accepted" or not all(intake.get(k) for k in ("message_id", "event_id", "sequence")):
            raise Refused("intake_receipt")
        data.update(intake=intake, cursor=intake["sequence"] - 1, phase="admitted", admitted_at=time.time())
        # Every Core message this adapter admitted is never mirrored back as web input.
        own = data.setdefault("own_messages", [])
        if intake["message_id"] not in own:
            own.append(intake["message_id"])
        worker.ledger.save(data)
    worker.fire_trigger(data)
    return True


def window(worker, data):
    """Join/open/queue with the original capacity, custody and generation gates."""
    from .worker import Refused
    if "window" not in data:
        if "window_request" not in data:
            current = worker.call("GET", "/window", allowed=(200, 204))
            if isinstance(current, dict) and current.get("state") in ("opening", "retiring", "reconciliation_required"):
                # The previous window is still closing or awaits Core's
                # reconciliation: nothing is frozen yet, so wait and retry.
                if data.get("phase") != "waiting_for_window":
                    data["phase"] = "waiting_for_window"
                    worker.ledger.save(data)
                return False
            data["previous_window"] = current
            data["window_request"] = worker.client.window_request(data["intake"], data["keys"]["message"], data["keys"]["window"], current)
            worker.ledger.save(data)
        status, reply = worker.client.request("POST", "/window", body=data["window_request"], allowed=(200, 201, 202, 409))
        if status == 202:
            # Durably queued in Core (capacity, or a follow-up that would get
            # under ten minutes of work time): Core's dispatcher opens the
            # window later, possibly as a successor. Replays of the same
            # frozen request report the queue row until it is dispatched.
            if not worker.window_queued(data, reply):
                return False
        elif status == 409:
            # A definite refusal is not authority to change the frozen request.
            # Busy windows may clear; stale tuples require operator review.
            code = reply.get("error", reply.get("code"))
            if isinstance(code, dict):
                code = code.get("code")
            if code == "window_busy":
                data["phase"] = "waiting_for_window"
                worker.ledger.save(data)
                return False
            raise Refused("window_refused")
        if status != 202:
            worker.window_admitted(data, reply)
    return True
