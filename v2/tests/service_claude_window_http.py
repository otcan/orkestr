"""Claude Deep in a real beta execution window, over real HTTP and root manager.

Run as root with a server built from the same source. Default: synthetic Claude
native (no provider). With --executable and --account (and the service
identity in ORKESTR_FIXTURE_SERVICE_UID/GID) it drives the installed CLI.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

from owned_execution_http import wait_for
from service_claude_window_case import ClaudeWindowCase


def path(conversation):
    return "/api/v2/conversations/" + conversation


def expect(case, route, code=200, method="GET", body=None):
    actual, value, _ = case.request(route, method, body)
    assert actual == code, (route, actual, value)
    return value


def proposal(case, previous=None, seconds=90):
    def ready():
        code, value, _ = case.request(path(case.conversation) + "/execution")
        if code != 200 or value["run_id"] == previous:
            return None
        assert value["phase"] not in ("blocked", "failed", "cancel_requested"), value
        return value if value["phase"] == "awaiting_acceptance" else None
    return wait_for(ready, "Claude window proposal", seconds)


def admit(case, key, text, window=None, generation=0, predecessor=None):
    receipt = expect(case, path(case.conversation) + "/messages", 202, "POST",
                     {"client_message_id": key, "text": text})
    request = {"request_key": "window:" + key, "input_message_id": receipt["message_id"],
               "input_event_id": receipt["event_id"], "input_request_key": key,
               "expected_generation": generation, "window_id": window,
               "predecessor_window_id": predecessor}
    return expect(case, path(case.conversation) + "/window", 201, "POST", request)["status"]


def turn(case, key, text, window=None, generation=0, previous=None, seconds=90, predecessor=None):
    status = admit(case, key, text, window, generation, predecessor)
    value = proposal(case, previous, seconds)
    payload = expect(case, path(case.conversation) + "/payloads/" + value["progress"]["payload_id"])
    accepted = expect(case, path(case.conversation) + "/accept", 200, "POST",
                      {**value["acceptance_candidate"], "expected_revision": value["revision"],
                       "request_key": "accept:" + key})
    assert accepted["outcome"] == "succeeded"
    return status, value, payload["text"]


def select_claude(case, real):
    """Owner selects Claude in the conversation settings (B3 API)."""
    current = expect(case, path(case.conversation) + "/settings")
    assert current["provider"] == "codex" and current["revision"] == 0
    update = {"expected_revision": 0, "provider": "claude",
              "model": None if real else "synthetic-claude-model",
              "reasoning_effort": "low", "honor_no_reply": True}
    selected = expect(case, path(case.conversation) + "/settings", 200, "PUT", update)
    assert selected["provider"] == "claude" and selected["provider_generation"] == 1, selected


def run(case, real):
    select_claude(case, real)
    prompts = (["Remember the codeword AMBER. Reply with exactly: pong",
                "What codeword did I give you? Reply with the single word only."] if real else
               ["synthetic window input 1", "synthetic window input 2"])
    window, first, text1 = turn(case, "claude:1", prompts[0])
    assert window["generation"] == 1
    assert ("pong" in text1.lower()) if real else text1 == "synthetic Claude turn 1", text1
    follow, second, text2 = turn(case, "claude:2", prompts[1], window["window_id"], 1, first["run_id"])
    assert follow["window_id"] == window["window_id"]
    assert ("amber" in text2.lower()) if real else text2 == "synthetic Claude turn 2", text2
    # Stop inside the window: genuine ACK + interrupted terminal, then the
    # window retires; the next input opens a successor that resumes the session.
    long_text = ("Write a detailed 1500-word essay about lighthouses." if real
                 else "synthetic window input hold")
    admit(case, "claude:3", long_text, window["window_id"], 1)
    def running():
        code, value, _ = case.request(path(case.conversation) + "/execution")
        return value if code == 200 and value["run_id"] != second["run_id"] and value["phase"] == "running" \
            and value["capabilities"]["stop"] else None
    live = wait_for(running, "stoppable Claude window turn", 60)
    expect(case, path(case.conversation) + "/stop", 200, "POST",
           {"run_id": live["run_id"], "expected_revision": live["revision"],
            "expected_control_revision": live["control_revision"], "request_key": "stop:3"})
    def settled():
        code, value, _ = case.request(path(case.conversation) + "/execution")
        return value if value["run_id"] == live["run_id"] and value["phase"] == "cancelled" else None
    wait_for(settled, "window Stop confirmed", 40)
    wait_for(lambda: [r["state"] for r in case.rows("SELECT state FROM execution_windows")] == ["closed"],
             "stopped window retired", 30)
    # The root manager retires its own record after Core closes the window.
    wait_for(lambda: [r["state"] for r in case.rows("SELECT state FROM windows", manager=True)] == ["retired"],
             "manager retired the stopped window", 30)
    successor, fourth, text4 = turn(
        case, "claude:4", "Repeat the codeword once more, single word." if real else "synthetic window input 4",
        None, 1, live["run_id"], predecessor=window["window_id"])
    assert successor["generation"] == 2 and successor["window_id"] != window["window_id"]
    assert ("amber" in text4.lower()) if real else text4 == "synthetic Claude turn 4", text4
    runs = case.rows("SELECT id,role,provider_kind,native_session_id,state FROM production_runs ORDER BY rowid")
    assert [(r["role"], r["provider_kind"], r["state"]) for r in runs] == [
        ("deep", "claude", "succeeded")] * 2 + [("deep", "claude", "cancelled"), ("deep", "claude", "succeeded")]
    assert len({r["native_session_id"] for r in runs}) == 1
    supervisors = case.rows("SELECT provider_kind FROM production_supervisors")
    assert {row["provider_kind"] for row in supervisors} == {"claude"}, supervisors
    trace = case.trace()
    if not real:
        spawns = [row for row in trace if row["kind"] == "spawn"]
        assert [row["resumed"] for row in spawns] == [False, True, True, True]
        assert {(row["model"], row["effort"]) for row in spawns} == {("synthetic-claude-model", "low")}
        assert len([row for row in trace if row["kind"] == "interrupt"]) == 1
    case.stop()
    final = case.rows("SELECT state FROM execution_windows")
    assert [row["state"] for row in final] == ["closed", "closed"], final
    return {"runs": runs, "windows": final, "texts": [text1[:40], text2[:40], text4[:40]]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--executable")
    parser.add_argument("--account")
    parser.add_argument("--keep-logs")
    args = parser.parse_args()
    real = args.executable is not None
    record = {"source": args.source, "binary_sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              "actual_provider": real, "passed": False}
    case = ClaudeWindowCase(args.source, args.executable, args.account)
    record["fixture"] = str(case.root)
    started = time.monotonic()
    try:
        case.setup()
        record.update(run(case, real), passed=True)
    except BaseException as error:
        record["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        try:
            case.cleanup(args.keep_logs)
        except BaseException as error:
            record["passed"] = False
            record["cleanup_error"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            record["elapsed_seconds"] = round(time.monotonic() - started, 3)
            with args.report.open("x") as stream:
                args.report.chmod(0o600)
                json.dump(record, stream, indent=2, default=str)
                stream.write("\n")
            print(json.dumps({key: record[key] for key in ("fixture", "passed", "elapsed_seconds")}), flush=True)
