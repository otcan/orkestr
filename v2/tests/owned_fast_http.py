"""Mounted ordinary Fast/Deep processes behind real authenticated HTTP routes."""
import json
import argparse
from pathlib import Path
import time
from owned_fast_case import FastCase
from owned_execution_group import stop_request
from owned_execution_http import wait_for


def independent_presentations(case):
    case.begin(deep="hold")
    deep = case.ready(0, "running")
    first = case.ready(1)
    initial = case.ledger()
    assert len(initial["runs"]) == 2 and initial["accepted"] == 0
    for field in ("id", "session_id", "native_session_id", "context_id"):
        assert len({row[field] for row in initial["runs"]}) == 2
    assert len({row["message_id"] for row in initial["runs"]}) == 1
    assert [row[1] for row in initial["inbox"]] == ["consumed"]
    assert len({row["pid_namespace"] for row in case.trace()}) == 2
    assert case.request(case.path + "/execution?run_id=" + first["run_id"])[0] == 404
    assert case.request(case.paths[1] + "/execution?run_id=" + deep["run_id"])[0] == 404
    assert case.request(case.path + "/stop", "POST", stop_request(first, "wrong-role"))[0] == 503
    assert case.request(case.paths[1] + "/stop", "POST", stop_request(deep, "wrong-role"))[0] == 503
    assert case.ledger() == initial
    queued = case.message(2)
    assert queued[0] == 202
    assert len(case.ledger()["runs"]) == 2
    assert [row[1] for row in case.ledger()["inbox"]] == ["consumed", "queued"]
    # Proposal alone cannot release Fast or advance the independently busy Deep.
    assert len(case.turns(1)) == 1 and len(case.turns(0)) == 1
    case.accept(1, "fast-accept-first")
    second = case.ready(1, previous=first["run_id"])
    assert second["run_id"] != first["run_id"]
    case.accept(1, "fast-accept-second")
    assert [row["input_index"] for row in case.turns(1)] == [1, 2]
    assert len({row["pid"] for row in case.turns(1)}) == 1
    assert len(case.turns(0)) == 1 and case.status(0, "running")
    after = case.ledger()
    assert len(after["runs"]) == 3 and after["accepted"] == 2
    assert [row[1] for row in after["inbox"]] == ["consumed", "queued"]
    assert case.message(2)[:2] == (200, queued[1])
    assert case.ledger() == after
    case.stop_role(0, "stop-only-deep")
    assert case.status(1, "completed") and not case.probes[1].gone()
    assert not any(row["kind"] == "interrupt" for row in case.trace_for(1))
    assert case.ledger()["held"] == 1


def both_roles_restart(case):
    case.begin()
    case.ready(0)
    case.ready(1)
    first = case.ledger()
    case.accept(0, "deep-before-restart")
    case.accept(1, "fast-before-restart")
    prior = case.process
    case.stop()
    assert prior.returncode == 0
    wait_for(case.peer_gone, "both accepted native trees retired")
    assert case.ledger()["retirements"] == 2
    trace = case.trace()
    case.start(configured=True)
    assert case.trace() == trace, "restart cannot launch without a fresh eligible input"
    assert case.message(2)[0] == 202
    case.ready(0)
    case.ready(1)
    case.accept(0, "deep-after-restart")
    case.accept(1, "fast-after-restart")
    final = case.ledger()
    assert len(final["runs"]) == 4 and final["accepted"] == 4
    assert all(row[1] == "consumed" for row in final["inbox"])
    for role in ("fast", "deep"):
        rows = [row for row in final["runs"] if row["role"] == role]
        assert len(rows) == 2
        assert len({row["session_id"] for row in rows}) == 1
        assert len({row["native_session_id"] for row in rows}) == 1
        assert len({row["context_id"] for row in rows}) == 1
        assert len({row["incarnation_id"] for row in rows}) == 2
        assert rows[0]["id"] in {row["id"] for row in first["runs"]}
    for index in range(2):
        ready = [row for row in case.trace_for(index) if row["kind"] == "ready"]
        assert [row["resumed"] for row in ready] == [False, True]
        # Namespace inode numbers may be recycled after the old tree is gone.
        # These host PID/start identities were independently resolved by Probe.
        assert len({(row["pid"], row["process_start"]) for row in ready}) == 2
        assert [row["input_index"] for row in case.turns(index)] == [1, 2]


def fast_stop_preserves_deep(case):
    case.begin(deep="hold", fast="hold")
    case.ready(0, "running")
    first = case.ready(1, "running")
    deep_before = case.turns(0)
    case.stop_role(1, "stop-fast-only")
    assert case.status(0, "running") and not case.probes[0].gone()
    assert case.turns(0) == deep_before and case.ledger()["held"] == 0
    (case.workspaces[1] / "mode").write_text("complete")
    assert case.message(2)[0] == 202
    case.ready(1, previous=first["run_id"])
    case.accept(1, "fast-after-stop")
    assert [row["input_index"] for row in case.turns(1)] == [1, 2]
    assert len({(row["pid"], row["process_start"]) for row in case.turns(1)}) == 2
    assert len({row["native"] for row in case.turns(1)}) == 1
    assert case.turns(0) == deep_before
    assert [row[1] for row in case.ledger()["inbox"]] == ["consumed", "queued"]
    case.stop_role(0, "finish-independent-deep")


def ack_is_unknown(case):
    case.begin(deep="hold", fast="ack-only")
    case.ready(0, "running")
    fast = case.ready(1, "running")
    body = stop_request(fast, "fast-ack-only")
    code, receipt, _ = case.request(case.paths[1] + "/stop", "POST", body)
    assert code == 200
    wait_for(lambda: case.trace_for(1) and case.probes[1].gone(), "unknown Fast child cleaned")
    assert case.status(1, "cancel_requested")
    assert case.status(0, "running") and not case.probes[0].gone()
    assert case.request(case.paths[1] + "/stop", "POST", body)[:2] == (200, receipt)
    assert case.ledger()["accepted"] == 0
    assert case.message(2)[0] == 202
    assert len(case.turns(1)) == 1, "unknown native delivery cannot create a replacement"
    case.stop_role(0, "finish-after-unknown-fast")


def revocation_fences_both(case):
    case.begin(deep="hold", fast="hold")
    case.ready(0, "running")
    case.ready(1, "running")
    case.revoke_machine()
    wait_for(case.peer_gone, "machine revocation cleans both distinct roles")
    assert case.ledger()["accepted"] == 0
    assert all(len(case.turns(index)) == 1 for index in range(2))


def long_turn_renewal(case):
    case.begin(deep="hold", fast="hold")
    case.ready(0, "running")
    fast = case.ready(1, "running")
    prior = next(row for row in case.ledger()["runs"] if row["role"] == "fast")
    peers = case.turns(1)
    def renewed():
        row = next(row for row in case.ledger()["runs"] if row["role"] == "fast")
        return row if row["lease_generation"] > prior["lease_generation"] else None
    current = wait_for(renewed, "ordinary Fast run must renew during quiet native work", seconds=26)
    assert current["id"] == fast["run_id"] and current["state"] == "running"
    assert current["native_session_id"] == prior["native_session_id"]
    assert case.turns(1) == peers and not case.probes[1].gone()
    case.stop_role(1, "stop-renewed-fast")
    assert case.status(0, "running") and not case.probes[0].gone()
    case.stop_role(0, "finish-renewed-parent")


def run_all(records):
    scenarios = [independent_presentations, both_roles_restart, fast_stop_preserves_deep,
                 ack_is_unknown, revocation_fences_both, long_turn_renewal]
    for scenario in scenarios:
        case = FastCase()
        started = time.monotonic()
        record = {"case": scenario.__name__, "passed": False}
        records.append(record)
        try:
            case.setup()
            scenario(case)
            record["ledger"] = case.ledger()
            record["trace"] = case.trace()
            record["passed"] = True
        except BaseException as error:
            record["error"] = f"{type(error).__name__}: {error}"
            raise
        finally:
            process = case.process
            try:
                case.cleanup()
                record["cleanup"] = {"home_removed": not case.root.exists(),
                    "all_observed_native_identities_gone": all(probe.gone() for probe in case.probes),
                    "server_exit": process.returncode if process else None}
                assert record["cleanup"]["home_removed"] and record["cleanup"]["all_observed_native_identities_gone"]
                assert process is None or process.returncode == 0
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
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    records = []
    try:
        run_all(records)
    finally:
        if args.report:
            with args.report.open("x") as stream:
                args.report.chmod(0o600)
                json.dump({"provider": "synthetic-executable", "full_release": False,
                           "cases": records}, stream, indent=2)
                stream.write("\n")
