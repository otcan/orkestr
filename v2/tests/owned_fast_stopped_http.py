"""Configured Fast restart requires genuine Stop and original owned reap proof."""
import argparse
import json
from pathlib import Path
import time
import uuid

from owned_execution_group import stop_request
from owned_execution_http import wait_for
from owned_fast_stopped_case import StoppedFastCase


def stopped_restart(case, held=False):
    case.begin(with_deep=held)
    first = case.ready(1, "running")
    if held:
        case.ready(0, "running")
        assert case.message(2)[0] == 202
        case.stop_role(0, "hold-old-deep-input")
    before = case.snapshot("before-fast-stop")
    assert len(before["held"]) == int(held)
    config_hash = case.fast_config_hash()
    request, receipt = case.stop_role(1, "stop-fast-before-shutdown")
    stopped = case.snapshot("stopped-before-shutdown")
    assert stopped["held"] == before["held"]
    assert stopped["stopped_retirements"] == []
    assert stopped["acceptances"] == []
    original = next(row for row in stopped["runs"] if row["role"] == "fast")
    assert original["id"] == first["run_id"] and original["state"] == "cancelled"
    uuid.UUID(original["native_session_id"])
    process = case.process
    case.stop()
    assert process.returncode == 0
    case.gone()
    retired = case.snapshot("stopped-retired-after-owned-shutdown")
    assert len(retired["stopped_retirements"]) == 1, "genuine stopped Fast must retire after owned shutdown"
    proof = retired["stopped_retirements"][0]
    assert proof["prior_run_id"] == first["run_id"]
    assert proof["context_id"] == original["context_id"]
    assert proof["incarnation_id"] == original["incarnation_id"]
    assert proof["stopped_event_id"] in {row["event_id"] for row in retired["observations"]
        if row["run_id"] == first["run_id"] and row["kind"] == "stopped"}
    assert retired["held"] == before["held"]
    assert retired["acceptances"] == [] and retired["accepted_retirements"] == []
    if held:
        # Deep supplied the real hold; only Fast restart is this test's subject.
        # Its exact private configuration is unchanged, and Deep is not restarted.
        case.select_fast_only()
    assert case.fast_config_hash() == config_hash
    case.start(configured=True)
    samples = case.idle_after_restart(retired)
    assert case.request(case.paths[1] + "/stop", "POST", request)[0] == 503
    assert case.snapshot()["runs"] == retired["runs"]
    number = 3 if held else 2
    assert case.message(number)[0] == 202
    current = case.ready(1, "running", previous=first["run_id"])
    successor = next(row for row in case.snapshot()["runs"] if row["id"] == current["run_id"])
    for key in ("session_id", "native_session_id", "context_id"):
        assert successor[key] == original[key], key
    assert successor["incarnation_id"] != original["incarnation_id"]
    assert successor["binding_generation"] == original["binding_generation"] + 1
    assert successor["attempt"] == 1
    before_replay = case.snapshot()
    assert case.request(case.paths[1] + "/stop", "POST", request)[0] == 503
    assert case.snapshot() == before_replay, "historical Stop changed fresh successor"
    turns = case.turns(1)
    assert [row["input_index"] for row in turns] == [1, number]
    assert len({(row["pid"], row["process_start"]) for row in turns}) == 2
    assert len({row["native"] for row in turns}) == 1
    assert [row["resumed"] for row in case.trace_for(1) if row["kind"] == "ready"] == [False, True]
    (case.workspaces[1] / f"release-{number}").touch()
    case.ready(1)
    case.accept(1, "accept-fresh-after-stopped-restart")
    final = case.snapshot("fresh-successor-owner-accepted")
    assert final["held"] == before["held"] and len(final["acceptances"]) == 1
    assert final["acceptances"][0]["run_id"] == successor["id"]
    assert final["stopped_retirements"] == retired["stopped_retirements"]
    if held:
        assert len(case.turns(0)) == 1 and case.probes[0].gone()
        assert final["inbox"][1]["event_id"] == final["held"][0]["event_id"]
        assert [row["state"] for row in final["inbox"]] == ["consumed", "queued", "queued"]
    else:
        assert all(row["state"] == "queued" for row in final["inbox"])
    return {"original_stop_request": request, "original_stop_receipt": receipt,
            "restart_idle_samples": samples, "same_fast_config_sha256": config_hash}


def refused_restart(case, reason):
    case.begin(fast="ack-only" if reason == "ack_only" else "complete" if reason == "unaccepted" else "hold")
    status = case.ready(1, "awaiting_acceptance" if reason == "unaccepted" else "running")
    if reason == "ack_only":
        request = stop_request(status, "ack-never-authorizes-restart")
        code, receipt, _ = case.request(case.paths[1] + "/stop", "POST", request)
        assert code == 200
        case.gone()
        assert case.status(1, "cancel_requested")
        assert case.request(case.paths[1] + "/stop", "POST", request)[:2] == (200, receipt)
    elif reason == "native_death":
        (case.workspaces[1] / "unexpected-exit").touch()
        case.gone()
        assert any(row["kind"] == "unexpected-exit" for row in case.trace_for(1))
    elif reason in ("revoked", "server_death"):
        case.stop_role(1, "genuine-stop-without-retirement")
        if reason == "revoked":
            case.revoke_machine()  # disposable fixture credential, no production state
        else:
            case.expected_abrupt_server_exit = True
            case.process.kill()
            assert case.process.wait(timeout=3) == -9
    else:
        assert reason == "unaccepted"
    case.stop()
    case.gone()
    before = case.snapshot("unproven-restart-refused-" + reason)
    assert before["stopped_retirements"] == [] and before["accepted_retirements"] == []
    assert before["acceptances"] == []
    if reason in ("ack_only", "native_death", "unaccepted"):
        assert not any(row["kind"] == "stopped" for row in before["observations"])
    case.refused_restart()
    return {"refusal": reason}


SCENARIOS = {
    "stopped_restart": lambda case: stopped_restart(case),
    "held_input_restart": lambda case: stopped_restart(case, held=True),
    **{name: lambda case, reason=name: refused_restart(case, reason)
       for name in ("ack_only", "native_death", "unaccepted", "revoked", "server_death")},
}


def run(names, records):
    for name in names:
        case = StoppedFastCase()
        record = {"case": name, "passed": False}
        records.append(record)
        started = time.monotonic()
        try:
            case.setup()
            record["details"] = SCENARIOS[name](case)
            record["passed"] = True
        except BaseException as error:
            record["error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            try:
                record["snapshots"] = case.snapshots
                record["trace"] = case.trace()
                record["final_ledger"] = case.snapshot()
            except BaseException as error:
                record["passed"] = False
                record["evidence_error"] = f"{type(error).__name__}: {error}"
                raise
            finally:
                try:
                    case.cleanup()
                    allowed = {0, -9} if case.expected_abrupt_server_exit else {0}
                    record["cleanup"] = {"home_removed": not case.root.exists(),
                        "all_observed_native_identities_gone": all(probe.gone() for probe in case.probes),
                        "server_exits": case.server_exits, "expected_refused_exits": case.refused_exits}
                    assert record["cleanup"]["home_removed"] and record["cleanup"]["all_observed_native_identities_gone"]
                    assert all(code in allowed for code in case.server_exits), case.server_exits
                    assert all(code != 0 for code in case.refused_exits)
                except BaseException as error:
                    record["passed"] = False
                    record["cleanup_error"] = f"{type(error).__name__}: {error}"
                    raise
                finally:
                    record["elapsed_ms"] = round((time.monotonic() - started) * 1000, 3)
        print(json.dumps({key: record[key] for key in ("case", "passed", "elapsed_ms")}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("binary")
    parser.add_argument("--case", choices=SCENARIOS)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    records = []
    try:
        run([args.case] if args.case else SCENARIOS, records)
    finally:
        if args.report:
            with args.report.open("x") as stream:
                args.report.chmod(0o600)
                json.dump({"provider": "synthetic-executable", "full_release": False,
                           "cases": records}, stream, indent=2)
                stream.write("\n")
