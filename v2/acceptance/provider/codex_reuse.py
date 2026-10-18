#!/usr/bin/env python3
"""Explicitly authorized two-turn acceptance through the ordinary HTTP server."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import time
import uuid
from urllib.parse import quote

from native_driver import ActiveCandidate, completion_payload, private_json, protected_cleanup
from prepare_http import Candidate, private_directory, private_write
from verify_package import Refused, require, verify


def ledger(root):
    # Read only this invocation's fresh synthetic database; never canonical state.
    uri = "file:" + quote(str(root / "data/core.sqlite3")) + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        runs = db.execute("SELECT state,attempt,session_id,native_session_id,message_id "
                          "FROM production_runs ORDER BY scope_sequence").fetchall()
        return {
            "runs": len(runs), "states": [row[0] for row in runs],
            "single_attempts": all(row[1] == 1 for row in runs),
            "sessions": len({row[2] for row in runs}),
            "native_sessions": len({row[3] for row in runs}),
            "native_identity_sha256": hashlib.sha256(runs[0][3].encode()).hexdigest() if runs else None,
            "messages": len({row[4] for row in runs}),
            "pending": db.execute("SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'").fetchone()[0],
            "accepted": db.execute("SELECT count(*) FROM production_acceptances").fetchone()[0],
        }


def projection(status):
    return {key: status.get(key) for key in ("phase", "run_id", "revision", "acceptance_candidate")}


def proposal(candidate, path, previous, global_deadline):
    deadline = min(global_deadline, time.monotonic() + 45)
    phases = []
    while time.monotonic() < deadline:
        candidate.observe()
        code, status, _ = candidate.browser(path + "/execution")
        require(code in (200, 204), "execution_read_failed")
        if code == 200:
            phase = status["phase"]
            if not phases or phases[-1] != phase:
                phases.append(phase)
            require(status["capabilities"] == {"stop": False, "steer": False}, "unexpected_control_capability")
            if status["run_id"] != previous:
                if phase == "awaiting_acceptance":
                    return status, phases
                require(phase not in ("completed", "failed", "blocked", "cancelled", "cancel_requested"),
                        "provider_did_not_propose_completion")
        time.sleep(.05)
    raise Refused("completion_deadline_exceeded")


def accept(candidate, path, status):
    target = status["acceptance_candidate"]
    require(target["run_id"] == status["run_id"], "acceptance_candidate_mismatch")
    request = {**target, "expected_revision": status["revision"], "request_key": "acceptance:" + uuid.uuid4().hex}
    code, receipt, _ = candidate.browser(path + "/accept", method="POST", body=request)
    require(code == 200 and receipt.get("outcome") == "succeeded", "owner_accept_failed")
    code, repeated, _ = candidate.browser(path + "/accept", method="POST", body=request)
    require(code == 200 and repeated == receipt, "acceptance_replay_changed")
    return request, receipt


def run(manifest_path, root, evidence_scope="actual_native_codex"):
    require(evidence_scope in ("actual_native_codex", "synthetic_native_fixture"), "evidence_scope_invalid")
    proof = verify(manifest_path)
    manifest = json.loads(Path(manifest_path).read_text())
    private_directory(root)
    prepared, config, session = [private_json(root / name) for name in
                                ("prepared.json", "execution.json", "synthetic-session.json")]
    require(prepared["manifest_sha256"] == proof["manifest_sha256"]
            and prepared["execution_config_sha256"] == hashlib.sha256((root / "execution.json").read_bytes()).hexdigest(),
            "preparation_pin_mismatch")
    require(config["conversation_id"] == session["conversation_id"]
            and config["launcher"] == manifest["artifacts"]["broker_launcher"]["path"]
            and config["launcher_sha256"] == manifest["artifacts"]["broker_launcher"]["sha256"],
            "execution_scope_mismatch")
    require(not (root / "data/owned-execution").exists(), "acceptance_reuse_refused")
    private_write(root / "activation-attempt.json", json.dumps({"source": proof["server_source"], "at": time.time()}) + "\n")
    candidate = ActiveCandidate(manifest["artifacts"]["server_binary"]["path"], root, session)
    candidate.native_path = manifest["artifacts"]["provider_native"]["path"]
    receipt = {"status": "failed", "evidence_scope": evidence_scope, "server_source": proof["server_source"], "broker_source": proof["broker_source"],
               "manifest_sha256": proof["manifest_sha256"], "server_sha256": proof["artifacts"]["server_binary"],
               "native_sha256": proof["artifacts"]["provider_native"], "executor_uid": os.geteuid(),
               "provider_launch_attempted": True, "stop_verified": False, "steer_verified": False,
               "multiturn_verified": False, "os_credential_isolation_verified": False, "checks": [], "turns": []}
    started = time.monotonic()
    deadline = started + 90
    requests, accepted = [], []
    try:
        candidate.start_active()
        path = "/api/v2/conversations/" + config["conversation_id"]
        token = "ORKESTR_V2_REUSE_" + uuid.uuid4().hex[:12]
        suffix = "SECOND_" + uuid.uuid4().hex[:8]
        intake = {"client_message_id": "acceptance:" + uuid.uuid4().hex,
                  "text": "Reply with exactly " + token + ". Do not use tools, run commands, inspect files, access the network, or change anything."}
        code, _, _ = candidate.browser(path + "/messages", method="POST", body=intake)
        require(code == 202, "ordinary_http_intake_failed")
        first, phases = proposal(candidate, path, None, deadline)
        output, count = completion_payload(candidate, path, first["run_id"], first["acceptance_candidate"]["completion_event_id"])
        require(output.strip() == token, "first_provider_output_mismatch")
        candidate.observe()
        require(len(candidate.native_seen) == 1, "native_process_identity_unproven")
        native_identity = set(candidate.native_seen)
        receipt["turns"].append({"phases": phases, "payload_count": count, "output_sha256": hashlib.sha256(output.encode()).hexdigest()})
        # Queue before owner acceptance: a provider proposal must never release it.
        followup = {"client_message_id": "acceptance:" + uuid.uuid4().hex,
                    "text": "Reply with the exact token you returned in your previous answer, then one space and " + suffix + ". Do not use tools, run commands, inspect files, access the network, or change anything."}
        code, intake_receipt, _ = candidate.browser(path + "/messages", method="POST", body=followup)
        require(code == 202, "followup_http_intake_failed")
        time.sleep(.3)
        code, retained, _ = candidate.browser(path + "/execution")
        before = ledger(root)
        require(code == 200 and retained["phase"] == "awaiting_acceptance" and retained["run_id"] == first["run_id"]
                and before["runs"] == 1 and before["pending"] == 1 and before["accepted"] == 0, "followup_dispatched_before_owner_acceptance")
        receipt["checks"].append("queued_followup_waited_for_owner_acceptance")
        request, answer = accept(candidate, path, retained)
        requests.append(request); accepted.append(answer)
        second, phases = proposal(candidate, path, first["run_id"], deadline)
        output, count = completion_payload(candidate, path, second["run_id"], second["acceptance_candidate"]["completion_event_id"])
        require(output.strip() == token + " " + suffix, "second_provider_output_or_context_mismatch")
        candidate.observe()
        require(candidate.native_seen == native_identity, "native_child_replaced")
        receipt["turns"].append({"phases": phases, "payload_count": count, "output_sha256": hashlib.sha256(output.encode()).hexdigest()})
        code, replayed, _ = candidate.browser(path + "/accept", method="POST", body=requests[0])
        require(code == 200 and replayed == accepted[0], "historical_acceptance_replay_changed")
        code, unchanged, _ = candidate.browser(path + "/execution")
        require(code == 200 and projection(unchanged) == projection(second), "historical_receipt_mutated_successor")
        request, answer = accept(candidate, path, second)
        requests.append(request); accepted.append(answer)
        code, duplicate, _ = candidate.browser(path + "/messages", method="POST", body=followup)
        require(code == 200 and duplicate == intake_receipt, "followup_intake_replay_changed")
        code, completed, _ = candidate.browser(path + "/execution")
        require(code == 200 and completed["phase"] == "completed" and completed["run_id"] == second["run_id"], "second_accepted_reload_failed")
        final = ledger(root)
        require(final["runs"] == final["messages"] == final["accepted"] == 2 and final["pending"] == 0
                and final["sessions"] == final["native_sessions"] == 1 and final["states"] == ["succeeded", "succeeded"]
                and final["single_attempts"], "two_turn_ledger_mismatch")
        receipt["ledger"] = final
        receipt["checks"].extend(["ordinary_http_two_turns", "same_native_pid_and_session", "prior_turn_context_retained",
                                  "historical_receipt_did_not_mutate_successor", "two_explicit_owner_acceptances", "duplicate_intake_did_not_redispatch"])
        receipt["multiturn_verified"] = True
        receipt["status"] = "passed"
    except Refused as error:
        receipt["code"] = str(error)
    except Exception:
        receipt["code"] = "acceptance_operation_unavailable"
    finally:
        receipt["owned_cleanup_complete"], interrupted = protected_cleanup(candidate.close_owned)
        receipt["forced_cleanup"] = candidate.forced_cleanup
        receipt["native_processes_observed"] = len(candidate.native_seen)
        receipt["duration_seconds"] = round(time.monotonic() - started, 3)
        if not receipt["owned_cleanup_complete"] or receipt["forced_cleanup"]:
            receipt["status"], receipt["code"] = "failed", "normal_owned_cleanup_failed"
        elif interrupted:
            receipt["status"], receipt["code"] = "failed", "attended_acceptance_interrupted"
    if receipt["status"] == "passed":
        reloaded = Candidate(manifest["artifacts"]["server_binary"]["path"], root)
        try:
            reloaded.start()  # No execution opt-in on this read-only restart.
            headers = {"Origin": reloaded.origin, "Cookie": session["cookie"], "x-orkestr-csrf": session["csrf"]}
            for request, answer in zip(requests, accepted):
                code, repeated, _ = reloaded.request(path + "/accept", method="POST", body=request, headers=headers)
                require(code == 200 and repeated == answer, "durable_receipt_replay_changed")
            code, persisted, _ = reloaded.request(path + "/execution", headers=headers)
            require(code == 200 and projection(persisted) == projection(completed), "accepted_state_after_restart_changed")
            require(ledger(root) == final, "restart_or_replay_redispatched")
            receipt["checks"].append("both_acceptances_persisted_after_disabled_restart")
        except Refused as error:
            receipt["status"], receipt["code"] = "failed", str(error)
        except Exception:
            receipt["status"], receipt["code"] = "failed", "restart_verification_unavailable"
        finally:
            _, interrupted = protected_cleanup(reloaded.stop)
            if interrupted:
                receipt["status"], receipt["code"] = "failed", "attended_acceptance_interrupted"
    private_write(root / "reuse-receipt.json", json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        raise Refused("attended_acceptance_interrupted")
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(number, interrupted)
    signal.alarm(120)
    try:
        result = run(sys.argv[1], Path(sys.argv[2]))
    except Refused as error:
        result = {"status": "refused", "code": str(error)}
    except Exception:
        result = {"status": "refused", "code": "acceptance_preflight_invalid"}
    signal.alarm(0)
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result["status"] == "passed" else 1)
