#!/usr/bin/env python3
"""Bounded, explicitly authorized Stop acceptance through ordinary owner HTTP."""
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

from native_driver import ActiveCandidate, exists, private_json, protected_cleanup
from prepare_http import Candidate, private_directory, private_write
from verify_package import Refused, require, verify


def ledger(root):
    uri = "file:" + quote(str(root / "data/core.sqlite3")) + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        runs = db.execute("SELECT state,attempt,session_id,native_session_id FROM production_runs").fetchall()
        observations = dict(db.execute("SELECT kind,count(*) FROM production_observations GROUP BY kind"))
        return {
            "runs": len(runs), "states": [row[0] for row in runs],
            "single_attempts": all(row[1] == 1 for row in runs),
            "sessions": len({row[2] for row in runs}),
            "native_sessions": len({row[3] for row in runs}),
            "native_identity_sha256": hashlib.sha256(runs[0][3].encode()).hexdigest() if runs else None,
            "observations": observations,
            "pending": db.execute("SELECT count(*) FROM reasoning_inbox WHERE state!='consumed'").fetchone()[0],
            "accepted": db.execute("SELECT count(*) FROM production_acceptances").fetchone()[0],
            "cancellations": db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0],
            "control_outbox": [row[0] for row in db.execute("SELECT state FROM production_control_outbox")],
        }


def wait_streaming(candidate, path):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        candidate.observe()
        code, status, _ = candidate.browser(path + "/execution")
        require(code in (200, 204), "execution_read_failed")
        if code == 200:
            require(not status["capabilities"]["steer"], "unexpected_steer_capability")
            if status["phase"] == "running" and status["capabilities"]["stop"]:
                if ledger(candidate.root)["observations"].get("progress", 0) > 0:
                    return status
            require(status["phase"] not in ("awaiting_acceptance", "completed", "failed", "blocked", "cancelled"),
                    "provider_not_streaming_at_stop")
        time.sleep(.02)
    raise Refused("streaming_deadline_exceeded")


def request_stop(candidate, path, status):
    # Streaming progress must not invalidate the original run control snapshot.
    # One submission proves this contract; conflict or uncertainty never refreshes
    # the intent, changes its run, or silently substitutes a newer precondition.
    run = status["run_id"]
    control_revision = status.get("control_revision")
    require(type(control_revision) is int and control_revision > 0, "explicit_control_revision_required")
    require(status["phase"] == "running" and status["capabilities"]["stop"], "stop_window_closed")
    request = {"run_id": run, "expected_revision": status["revision"],
               "expected_control_revision": control_revision,
               "request_key": "acceptance-stop:" + uuid.uuid4().hex}
    code, receipt, headers = candidate.browser(path + "/stop", method="POST", body=request)
    require(code != 409, "stop_precondition_conflict")
    require(code == 200 and receipt.get("outcome") == "requested_unknown", "stop_handoff_unconfirmed")
    require("no-store" in headers.get("Cache-Control", ""), "stop_receipt_not_private")
    require(set(receipt) == {"schema_version", "conversation_id", "run_id", "request_key",
                             "requested_revision", "revision", "outcome"}, "private_control_disclosed")
    require(receipt["run_id"] == run and receipt["request_key"] == request["request_key"]
            and receipt["requested_revision"] == request["expected_revision"], "stop_receipt_mismatch")
    code, replay, _ = candidate.browser(path + "/stop", method="POST", body=request)
    require(code == 200 and replay == receipt, "stop_receipt_replay_changed")
    return request, receipt, 0


def wait_stopped(candidate, path, run):
    deadline = time.monotonic() + 6
    phases = []
    while time.monotonic() < deadline:
        candidate.observe()
        code, status, _ = candidate.browser(path + "/execution")
        require(code == 200 and status["run_id"] == run, "stop_scope_changed")
        require(status["capabilities"] == {"stop": False, "steer": False}, "control_remained_available")
        phase = status["phase"]
        if not phases or phases[-1] != phase:
            phases.append(phase)
        require(phase in ("cancel_requested", "cancelled"), "stop_became_non_cancel_terminal")
        snapshot = ledger(candidate.root)
        if phase == "cancelled":
            require(snapshot["observations"].get("stopped", 0) == 1, "cancelled_without_terminal_evidence")
            return status, phases
        # This read is later than the HTTP snapshot. Terminal evidence may have
        # committed between them; read the next projection instead of calling
        # that legitimate transition an inconsistency.
        time.sleep(.02)
    raise Refused("provider_stop_unconfirmed")


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
            and config["launcher_sha256"] == manifest["artifacts"]["broker_launcher"]["sha256"], "execution_scope_mismatch")
    require(not (root / "data/owned-execution").exists(), "acceptance_reuse_refused")
    private_write(root / "activation-attempt.json", json.dumps({"source": proof["server_source"], "at": time.time()}) + "\n")
    candidate = ActiveCandidate(manifest["artifacts"]["server_binary"]["path"], root, session)
    candidate.native_path = manifest["artifacts"]["provider_native"]["path"]
    receipt = {"status": "failed", "evidence_scope": evidence_scope, "server_source": proof["server_source"],
               "broker_source": proof["broker_source"], "manifest_sha256": proof["manifest_sha256"],
               "server_sha256": proof["artifacts"]["server_binary"], "native_sha256": proof["artifacts"]["provider_native"],
               "executor_uid": os.geteuid(), "provider_launch_attempted": True, "stop_verified": False,
               "steer_verified": False, "os_credential_isolation_verified": False, "checks": []}
    started = time.monotonic()
    path = "/api/v2/conversations/" + config["conversation_id"]
    try:
        candidate.start_active()
        code, _, _ = candidate.browser(path + "/messages", method="POST", body={
            "client_message_id": "acceptance:" + uuid.uuid4().hex,
            "text": "Output the integers 1 through 1000, one per line. Start directly with 1 and do not summarize. Do not use tools, run commands, inspect files, access the network, or change anything."})
        require(code == 202, "ordinary_http_intake_failed")
        running = wait_streaming(candidate, path)
        candidate.observe()
        require(len(candidate.native_seen) == 1, "native_process_identity_unproven")
        native_identity = set(candidate.native_seen)
        receipt["checks"].append("actual_native_streaming_before_stop")
        request, answer, conflicts = request_stop(candidate, path, running)
        receipt["revision_conflicts"] = conflicts
        receipt["intent_outcome"] = answer["outcome"]
        receipt["checks"].append("durable_stop_intent_and_exact_replay")
        final, phases = wait_stopped(candidate, path, running["run_id"])
        receipt["phases_after_intent"] = phases
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            candidate.observe()
            descendants = [p for p in candidate.known.values() if p["pid"] != candidate.child.pid]
            if descendants and not any(exists(p) for p in descendants):
                break
            time.sleep(.02)
        require(descendants and not any(exists(p) for p in descendants), "owned_provider_tree_not_reaped")
        require(candidate.native_seen == native_identity, "native_child_replaced")
        code, replay, _ = candidate.browser(path + "/stop", method="POST", body=request)
        require(code == 200 and replay == answer, "stop_replay_after_cleanup_changed")
        snapshot = ledger(root)
        require(snapshot["runs"] == snapshot["sessions"] == snapshot["native_sessions"] == 1
                and snapshot["states"] == ["cancelled"] and snapshot["single_attempts"]
                and snapshot["accepted"] == snapshot["pending"] == 0 and snapshot["cancellations"] == 1
                and snapshot["control_outbox"] == ["acknowledged"]
                and snapshot["observations"].get("completed_proposal", 0) == 0
                and snapshot["observations"].get("stopped", 0) == 1, "stopped_ledger_mismatch")
        receipt["checks"].extend(["terminal_provider_evidence_before_cancelled", "one_durable_stop_intent",
                                  "owned_provider_tree_reaped_before_server_shutdown", "no_completion_acceptance_or_redispatch"])
        receipt["stop_verified"] = True
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
        receipt["ledger"] = ledger(root)
        if not receipt["owned_cleanup_complete"] or receipt["forced_cleanup"]:
            receipt["status"], receipt["code"] = "failed", "normal_owned_cleanup_failed"
        elif interrupted:
            receipt["status"], receipt["code"] = "failed", "attended_acceptance_interrupted"
    if receipt["status"] == "passed":
        reloaded = Candidate(manifest["artifacts"]["server_binary"]["path"], root)
        try:
            reloaded.start()
            headers = {"Origin": reloaded.origin, "Cookie": session["cookie"], "x-orkestr-csrf": session["csrf"]}
            code, persisted, _ = reloaded.request(path + "/execution", headers=headers)
            require(code == 200 and all(persisted.get(key) == final.get(key)
                    for key in ("phase", "run_id", "revision", "capabilities")), "cancelled_state_after_restart_changed")
            code, _, _ = reloaded.request(path + "/stop", method="POST", body=request, headers=headers)
            require(code == 503, "disabled_restart_fabricated_control_capability")
            require(ledger(root) == snapshot, "restart_or_replay_mutated_stop")
            receipt["checks"].append("cancelled_state_persisted_with_control_disabled_after_restart")
        except Refused as error:
            receipt["status"], receipt["code"] = "failed", str(error)
        except Exception:
            receipt["status"], receipt["code"] = "failed", "restart_verification_unavailable"
        finally:
            _, interrupted = protected_cleanup(reloaded.stop)
            if interrupted:
                receipt["status"], receipt["code"] = "failed", "attended_acceptance_interrupted"
    private_write(root / "stop-receipt.json", json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        raise Refused("attended_acceptance_interrupted")
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(number, interrupted)
    signal.alarm(75)
    try:
        result = run(sys.argv[1], Path(sys.argv[2]))
    except Refused as error:
        result = {"status": "refused", "code": str(error)}
    except Exception:
        result = {"status": "refused", "code": "acceptance_preflight_invalid"}
    signal.alarm(0)
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result["status"] == "passed" else 1)
