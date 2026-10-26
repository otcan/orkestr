"""Refresh only an exact unchanged proposal after a definite HTTP conflict."""


def reconcile(worker, data, role, ids):
    from .worker import Refused
    # Canonical acceptance wins, including an auto-accept racing our request.
    # This read also proves there is no retained acceptance before refreshing.
    try:
        worker.adopt_acceptance(data, role, data[role + "_accept_request"]["run_id"], ids)
        return True
    except Refused as error:
        if str(error) != "execution_requires_review":
            raise
    request = data[role + "_accept_request"]
    value = worker.role_status(data, role, ids) or {}
    if worker.accepted_elsewhere(value, ids):
        # The acceptance may have committed between history and status reads.
        worker.adopt_acceptance(data, role, request["run_id"], ids)
        return True
    candidate = value.get("acceptance_candidate") or {}
    payload = data.get(role + "_payload") or {}
    revision = value.get("revision")
    if (value.get("phase") != "awaiting_acceptance" or
            value.get("run_id") != request["run_id"] or request["run_id"] not in ids or
            candidate.get("run_id") != request["run_id"] or
            candidate.get("completion_event_id") != request["completion_event_id"] or
            payload.get("run_id") != request["run_id"] or
            not payload.get("payload_id") or
            (value.get("progress") or {}).get("payload_id") != payload["payload_id"] or
            request.get("request_key") != data["keys"][role] or
            type(revision) is not int or type(request.get("expected_revision")) is not int or
            revision <= request["expected_revision"]):
        raise Refused("execution_requires_review")
    # Called only for a definite authenticated 409. Unknown transport outcomes
    # never reach here and retain the original request byte-for-byte. The same
    # run/completion/payload/key remain frozen; only Core's newer revision moves.
    data[role + "_accept_request"] = dict(request, expected_revision=revision)
    worker.ledger.save(data)
    return False  # Retry this exact refreshed request on the next normal pass.
