"""Existing Worker turns survive an ordinary parent proposal, then retire exactly."""
from owned_execution_http import wait_for
from owned_native_probe import process_start


def run(case):
    # Import after the entry module has defined its shared finite HTTP helpers.
    from service_roles_http import accept, expect, intake, path, ready, review, status, window_request

    results = []
    for parent_first, number in [(False, 51), (True, 52)]:
        conversation = expect(case, "/api/v2/conversations", 201, "POST", {
            "client_request_id": f"retained:{number}",
            "name": f"Synthetic retained Worker {number}",
        })["conversation_id"]
        review(case, conversation)
        case.fixture.write_private(case.workspaces["deep"] / "mode", b"hold")
        case.fixture.write_private(case.workspaces["worker-0"] / "mode", b"hold")
        key = f"retained:input:{number}"
        receipt = intake(case, conversation, key, number)
        expect(case, path(conversation) + "/window", 201, "POST",
               window_request(receipt, key))
        parent = ready(case, conversation, "deep", "running")
        fast = ready(case, conversation, "fast")
        task_path = path(conversation) + "/worker-tasks"
        listing = task_path + "?parent_run_id=" + parent["run_id"]
        wait_for(lambda: expect(case, listing)["can_create"], "retention task scheduler")
        current = ready(case, conversation, "deep", "running", run=parent["run_id"])
        task = expect(case, task_path, 200, "POST", {
            "parent_run_id": parent["run_id"],
            "expected_control_revision": current["control_revision"],
            "request_key": f"retained:worker:{number}", "title": "Retained Worker",
            "instructions": f"synthetic ordinary HTTP input {number + 20}",
            "lifetime_ms": 30000, "execution_budget_ms": 60000,
        })
        assert task["source_message_id"] == receipt["message_id"]
        assert task["source_event_id"] == receipt["event_id"]

        def row():
            rows = expect(case, listing)["tasks"]
            assert len(rows) == 1 and rows[0]["task"] == task
            assert rows[0]["phase"] not in ("blocked", "failed", "cancelled", "held")
            return rows[0] if rows[0]["run_id"] else None

        worker = wait_for(row, "retention Worker run", 20)
        worker_id = worker["run_id"]

        def original():
            rows = [r for r in case.trace() if r["kind"] == "turn" and
                    r["role"] == "worker-0" and r["input_index"] == number + 20]
            assert len(rows) <= 1
            return rows[0] if rows else None

        native = wait_for(original, "original retention Worker native identity", 10)
        ready(case, conversation, "deep", "running", run=worker_id)
        if not parent_first:
            (case.workspaces["worker-0"] / f"release-{number + 20}").touch()
            ready(case, conversation, "deep", run=worker_id)
        (case.workspaces["deep"] / f"release-{number}").touch()
        parent_proposal = ready(case, conversation, "deep", run=parent["run_id"])
        assert expect(case, listing)["can_create"] is False
        assert expect(case, path(conversation) + "/intelligence")["worker"]["available"] is False
        # Parent output cannot be accepted over its unfinished child decision.
        parent_proposal = ready(case, conversation, "deep", run=parent["run_id"])
        refusal = expect(case, path(conversation) + "/accept", 409, "POST", {
            **parent_proposal["acceptance_candidate"],
            "expected_revision": parent_proposal["revision"],
            "request_key": f"retained:premature-parent:{number}",
        })
        assert refusal["code"] == "execution_unavailable"
        if parent_first:
            still_running = status(case, conversation, run=worker_id)
            assert still_running["phase"] == "running"
            (case.workspaces["worker-0"] / f"release-{number + 20}").touch()
        proposal = ready(case, conversation, "deep", run=worker_id)
        completion = proposal["acceptance_candidate"]["completion_event_id"]
        # This native process must be reaped before any owner accepts its output.
        # A status label, a copied identifier or a fresh cleanup process is not proof.
        wait_for(lambda: process_start(native["pid"]) != native["process_start"],
                 "completed Worker original reaped before owner decision", 10)
        after = ready(case, conversation, "deep", run=worker_id)
        assert after["acceptance_candidate"]["completion_event_id"] == completion
        assert after["progress"]["payload_id"] == proposal["progress"]["payload_id"]
        bindings = case.rows("SELECT r.state AS run_state,b.state AS binding_state "
                             "FROM production_runs r JOIN session_bindings b ON b.id=r.session_id "
                             "WHERE r.id=?", (worker_id,))
        assert bindings == [{"run_state": "awaiting_acceptance", "binding_state": "busy"}]
        worker_receipt = accept(case, conversation, after, f"retained:accept-worker:{number}")
        fast["_role"] = "fast"
        fast_receipt = accept(case, conversation, fast, f"retained:accept-fast:{number}")
        parent_receipt = accept(case, conversation, parent_proposal,
                                f"retained:accept-parent:{number}")
        accepted = expect(case, path(conversation) + "/accepted-results?after_sequence=0&limit=20")
        assert len(accepted["results"]) == 3
        assert {r["run_id"] for r in accepted["results"]} == {
            worker_id, parent["run_id"], fast["run_id"]}
        results.append({"conversation_id": conversation, "parent_completed_first": parent_first,
                        "worker_original": native, "worker_reaped_before_acceptance": True,
                        "acceptances": [worker_receipt, fast_receipt, parent_receipt]})
    return results
