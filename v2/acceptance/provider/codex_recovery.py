#!/usr/bin/env python3
"""Attended Stop/resume and clean configured restart acceptance; never auto-run."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time
import uuid

from codex_reuse import accept, projection
from codex_stop import request_stop, wait_stopped, wait_streaming
from native_driver import completion_payload, exists, private_json, protected_cleanup
from prepare_http import private_directory, private_write
from recovery_process import RecoveryCandidate
from recovery_state import exact_run, held_input, normal_retirement, public_hold, snapshot, summary
from verify_package import Refused, require, verify

NO_TOOLS = " Do not use tools, run commands, inspect files, access the network, or change anything."


def admit(candidate, path, text):
    body = {"client_message_id": "recovery:" + uuid.uuid4().hex, "text": text + NO_TOOLS}
    code, receipt, _ = candidate.browser(path + "/messages", method="POST", body=body)
    require(code == 202 and isinstance(receipt, dict), "recovery_intake_failed")
    for key in ("message_id", "event_id"):
        uuid.UUID(receipt[key])
    require(type(receipt.get("sequence")) is int and receipt["sequence"] > 0, "recovery_intake_sequence_missing")
    return body, receipt


def proposal(candidate, path, previous, deadline):
    until = min(deadline, time.monotonic() + 45)
    while time.monotonic() < until:
        candidate.observe()
        code, status, _ = candidate.browser(path + "/execution")
        require(code == 200, "recovery_status_unavailable")
        require(not status["capabilities"]["steer"], "unexpected_steer_capability")
        if status["run_id"] != previous:
            require(status["run_id"] is not None, "recovery_run_not_identified")
            if status["phase"] == "awaiting_acceptance":
                require(not status["capabilities"]["stop"], "terminal_stop_capability_invented")
                return status
            require(status["phase"] not in ("failed", "blocked", "cancelled", "cancel_requested", "completed"),
                    "recovery_turn_did_not_propose")
        time.sleep(.02)
    raise Refused("recovery_proposal_deadline")


def await_gone(candidate, identity):
    until = time.monotonic() + 3
    while time.monotonic() < until:
        candidate.observe()
        if not any(exists(candidate.known[item]) for item in identity):
            return
        time.sleep(.02)
    raise Refused("stopped_native_not_reaped")


def output_matches(candidate, path, status, expected):
    output, count = completion_payload(candidate, path, status["run_id"],
                                        status["acceptance_candidate"]["completion_event_id"])
    require(output.strip() == expected, "recovery_provider_context_or_output_mismatch")
    return {"payload_count": count, "output_sha256": hashlib.sha256(output.encode()).hexdigest()}


def close(candidate):
    complete, interrupted = protected_cleanup(candidate.close_owned)
    require(complete and not candidate.forced_cleanup, "recovery_normal_cleanup_failed")
    require(not interrupted, "recovery_interrupted_during_cleanup")


def replay_without_mutation(candidate, path, action, request, original, status, root):
    before = snapshot(root)
    code, replay, _ = candidate.browser(path + action, method="POST", body=request)
    require(code == 200 and replay == original, "recovery_historical_receipt_changed")
    code, after, _ = candidate.browser(path + "/execution")
    require(code == 200 and projection(after) == projection(status) and snapshot(root) == before,
            "recovery_historical_receipt_mutated_successor")


def run(manifest_path, root, evidence_scope="actual_native_codex"):
    require(evidence_scope in ("actual_native_codex", "synthetic_native_fixture"), "evidence_scope_invalid")
    proof = verify(manifest_path)
    require(proof["schema_version"] == 3, "recovery_lifetime_package_required")
    manifest = json.loads(Path(manifest_path).read_text())
    private_directory(root)
    prepared, config, session = [private_json(root / name) for name in
                                ("prepared.json", "execution.json", "synthetic-session.json")]
    config_hash = hashlib.sha256((root / "execution.json").read_bytes()).hexdigest()
    require(prepared["manifest_sha256"] == proof["manifest_sha256"]
            and prepared["execution_config_sha256"] == config_hash, "preparation_pin_mismatch")
    require(config["conversation_id"] == session["conversation_id"]
            and config["launcher"] == manifest["artifacts"]["broker_launcher"]["path"]
            and config["launcher_sha256"] == manifest["artifacts"]["broker_launcher"]["sha256"],
            "execution_scope_mismatch")
    require(not (root / "data/owned-execution").exists(), "acceptance_reuse_refused")
    # The committed held-input schema is a prerequisite, never fabricated here.
    initial = snapshot(root)
    require(not initial["runs"] and not initial["held"] and not initial["retirements"],
            "recovery_state_not_fresh")
    private_write(root / "activation-attempt.json", json.dumps({"source": proof["server_source"], "at": time.time()}) + "\n")
    def candidate():
        value = RecoveryCandidate(manifest["artifacts"]["server_binary"]["path"], root, session)
        value.native_path = manifest["artifacts"]["provider_native"]["path"]
        return value
    active, restarted = candidate(), None
    receipt = {"status": "failed", "evidence_scope": evidence_scope, "server_source": proof["server_source"],
               "broker_source": proof["broker_source"], "manifest_sha256": proof["manifest_sha256"],
               "server_sha256": proof["artifacts"]["server_binary"], "native_sha256": proof["artifacts"]["provider_native"],
               "executor_uid": os.geteuid(), "provider_launch_attempted": True, "checks": [], "outputs": [],
               "stop_recovery_verified": False, "configured_restart_verified": False,
               "steer_verified": False, "os_credential_isolation_verified": False}
    started, deadline = time.monotonic(), time.monotonic() + 150
    path = "/api/v2/conversations/" + config["conversation_id"]
    try:
        active.start_active()
        _, first_input = admit(active, path, "Output the integers 1 through 1000, one per line. Start directly with 1 and do not summarize.")
        running = wait_streaming(active, path)
        active.observe()
        require(len(active.native_seen) == 1, "first_native_identity_unproven")
        first_native = set(active.native_seen)
        old_request, old_input = admit(active, path, "Reply exactly HELD_INPUT_MUST_NOT_EXECUTE.")
        stop_request, stop_receipt, _ = request_stop(active, path, running)
        wait_stopped(active, path, running["run_id"])
        await_gone(active, first_native)
        stopped = snapshot(root)
        first = exact_run(stopped, running["run_id"], first_input)
        hold = held_input(stopped, old_input, first["id"], stop_request["request_key"])
        public_hold(active, path, hold)
        require(first["state"] == "cancelled" and len(stopped["runs"]) == 1, "stopped_input_replayed")
        require(hold["text_sha256"] == hashlib.sha256(old_request["text"].encode()).hexdigest(),
                "held_input_content_changed")
        code, old_replay, _ = active.browser(path + "/messages", method="POST", body=old_request)
        require(code == 200 and old_replay == old_input and snapshot(root) == stopped,
                "held_input_intake_replay_changed_authority")
        receipt["checks"].append("confirmed_stop_holds_prior_input_and_reaps_native")

        token = "RECOVERY_" + uuid.uuid4().hex[:12]
        _, second_input = admit(active, path, "Reply with exactly " + token + ".")
        second_status = proposal(active, path, first["id"], deadline)
        receipt["outputs"].append(output_matches(active, path, second_status, token))
        active.observe()
        require(len(active.native_seen) == 2 and first_native < active.native_seen,
                "stop_recovery_native_process_not_replaced_once")
        second_state = snapshot(root)
        second = exact_run(second_state, second_status["run_id"], second_input)
        require(second["native_session_id"] == first["native_session_id"]
                and second["session_id"] == first["session_id"]
                and second["incarnation_id"] == first["incarnation_id"]
                and second["scope_sequence"] > hold["through_scope_sequence"], "stopped_resume_identity_changed")
        require(held_input(second_state, old_input, first["id"], stop_request["request_key"]) == hold,
                "stopped_resume_released_old_input")
        public_hold(active, path, hold)
        replay_without_mutation(active, path, "/stop", stop_request, stop_receipt, second_status, root)
        second_request, second_receipt = accept(active, path, second_status)
        completed = snapshot(root)
        require(len(completed["runs"]) == 2 and completed["accepted"] == 1
                and completed["runs"][1]["state"] == "succeeded", "post_stop_acceptance_missing")
        receipt["checks"].extend(["fresh_post_stop_input_only", "same_native_session_new_owned_process",
                                  "historical_stop_replay_did_not_mutate_successor", "post_stop_owner_acceptance"])
        close(active)
        before_restart = snapshot(root)
        require(before_restart["runs"] == completed["runs"] and before_restart["held"] == completed["held"],
                "clean_shutdown_rewrote_history_or_hold")
        normal_retirement(before_restart, second, second_receipt, 1)
        old_incarnation = before_restart["supervisors"][0]["incarnation_id"]
        receipt["stop_recovery_verified"] = True

        require(hashlib.sha256((root / "execution.json").read_bytes()).hexdigest() == config_hash,
                "recovery_configuration_changed")
        restarted = candidate()
        restarted.start_active()  # Identical execution config; no bootstrap/state reset.
        code, retained, _ = restarted.browser(path + "/execution")
        require(code == 200 and retained["run_id"] == second["id"] and retained["phase"] == "completed",
                "configured_restart_lost_terminal_history")
        replay_without_mutation(restarted, path, "/accept", second_request, second_receipt, retained, root)
        require(snapshot(root)["runs"] == before_restart["runs"], "configured_restart_redispatched_history")
        suffix = "RESTART_" + uuid.uuid4().hex[:8]
        _, third_input = admit(restarted, path, "Reply with the exact token from your previous answer, then one space and " + suffix + ".")
        third_status = proposal(restarted, path, second["id"], deadline)
        receipt["outputs"].append(output_matches(restarted, path, third_status, token + " " + suffix))
        restarted.observe()
        require(len(restarted.native_seen) == 1 and not (restarted.native_seen & active.native_seen),
                "restart_native_identity_not_new")
        third_state = snapshot(root)
        third = exact_run(third_state, third_status["run_id"], third_input)
        require(third["native_session_id"] == first["native_session_id"]
                and third["session_id"] == first["session_id"]
                and third["context_id"] == first["context_id"]
                and third["incarnation_id"] != old_incarnation, "restart_incarnation_or_session_mismatch")
        require(held_input(third_state, old_input, first["id"], stop_request["request_key"]) == hold,
                "restart_released_held_input")
        public_hold(restarted, path, hold)
        require(third_state["runs"][:2] == before_restart["runs"], "restart_mutated_historical_runs")
        replay_without_mutation(restarted, path, "/accept", second_request, second_receipt, third_status, root)
        _, third_receipt = accept(restarted, path, third_status)
        final = snapshot(root)
        require([run["state"] for run in final["runs"]] == ["cancelled", "succeeded", "succeeded"]
                and final["accepted"] == 2 and final["cancellations"] == 1
                and final["controls"] == [{"state": "acknowledged"}], "recovery_final_ledger_mismatch")
        require(held_input(final, old_input, first["id"], stop_request["request_key"]) == hold,
                "recovery_final_hold_changed")
        receipt["checks"].extend(["same_config_clean_restart", "new_incarnation_fresh_dispatch",
                                  "native_context_survived_restart", "historical_acceptance_replay_unchanged",
                                  "pre_stop_input_remained_held_without_redispatch"])
        receipt["configured_restart_verified"], receipt["status"] = True, "passed"
    except Refused as error:
        receipt["code"] = str(error)
    except Exception:
        receipt["code"] = "recovery_operation_unavailable"
    finally:
        cleanup = []
        for value in (restarted, active):
            if value is None:
                continue
            try:
                complete, interrupted = protected_cleanup(value.close_owned)
                cleanup.append(complete and not interrupted and not value.forced_cleanup)
            except Exception:
                cleanup.append(False)
        receipt["owned_cleanup_complete"] = all(cleanup)
        receipt["forced_cleanup"] = active.forced_cleanup or bool(restarted and restarted.forced_cleanup)
        receipt["native_processes_observed"] = len(active.native_seen | (restarted.native_seen if restarted else set()))
        try:
            closed = snapshot(root)
            receipt["ledger"] = summary(closed)
            if receipt["status"] == "passed":
                normal_retirement(closed, third, third_receipt, 2)
                require(closed["retirements"][0] == before_restart["retirements"][0],
                        "restart_mutated_prior_retirement")
        except Refused as error:
            receipt["status"], receipt["code"] = "failed", str(error)
        except Exception:
            receipt["ledger_unavailable"] = True
            receipt["status"], receipt["code"] = "failed", "recovery_final_ledger_unavailable"
        receipt["duration_seconds"] = round(time.monotonic() - started, 3)
        if not all(cleanup):
            receipt["status"], receipt["code"] = "failed", "recovery_normal_cleanup_failed"
    private_write(root / "recovery-receipt.json", json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    def interrupted(_number, _frame):
        raise Refused("recovery_acceptance_interrupted")
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(number, interrupted)
    signal.alarm(180)
    try:
        result = run(sys.argv[1], Path(sys.argv[2]))
    except Refused as error:
        result = {"status": "refused", "code": str(error)}
    except Exception:
        result = {"status": "refused", "code": "recovery_preflight_invalid"}
    signal.alarm(0)
    print(json.dumps(result, sort_keys=True))
    raise SystemExit(0 if result["status"] == "passed" else 1)
