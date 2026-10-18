"""Read-only oracles for a separately qualified ordinary recovery candidate."""
import hashlib
import sqlite3
from urllib.parse import quote

from verify_package import require


def snapshot(root):
    uri = "file:" + quote(str(root / "data/core.sqlite3")) + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        def rows(sql):
            return [dict(row) for row in db.execute(sql)]
        state = {
            "runs": rows("SELECT id,state,attempt,session_id,native_session_id,message_id,event_id,"
                         "scope_sequence,context_id,incarnation_id,role,binding_generation "
                         "FROM production_runs ORDER BY scope_sequence"),
            "held": rows("SELECT h.message_id,h.event_id,h.scope_sequence,h.boundary_event_id,h.reason,"
                         "b.run_id AS boundary_run_id,b.through_scope_sequence,i.state,i.admitted_run_id,"
                         "c.request_key AS boundary_request_key,m.text AS held_text "
                         "FROM production_held_inputs h JOIN production_stop_boundaries b "
                         "ON b.event_id=h.boundary_event_id JOIN production_cancellations c "
                         "ON c.event_id=b.event_id JOIN reasoning_inbox i ON i.event_id=h.event_id "
                         "JOIN messages m ON m.id=h.message_id "
                         "ORDER BY h.scope_sequence"),
            "supervisors": rows("SELECT context_id,incarnation_id,generation FROM production_supervisors"),
            "retirements": rows("SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,"
                                "acceptance_event_id,session_id,binding_generation,retired_at_ms "
                                "FROM production_graceful_retirements ORDER BY retired_at_ms,prior_run_id"),
            "pending": rows("SELECT message_id,event_id,state,admitted_run_id FROM reasoning_inbox "
                            "WHERE state!='consumed' ORDER BY sequence"),
            "accepted": db.execute("SELECT count(*) FROM production_acceptances").fetchone()[0],
            "cancellations": db.execute("SELECT count(*) FROM production_cancellations").fetchone()[0],
            "controls": rows("SELECT state FROM production_control_outbox ORDER BY rowid"),
            "observations": rows("SELECT run_id,kind,count(*) AS count FROM production_observations "
                                 "GROUP BY run_id,kind ORDER BY run_id,kind"),
        }
        for held in state["held"]:
            held["text_sha256"] = hashlib.sha256(held.pop("held_text").encode()).hexdigest()
        return state


def held_input(state, intake, stopped_run, stop_key):
    require(len(state["held"]) == len(state["pending"]) == 1, "held_input_count_changed")
    held = state["held"][0]
    require(held["message_id"] == intake["message_id"] and held["event_id"] == intake["event_id"]
            and held["reason"] == "stop_boundary" and held["boundary_run_id"] == stopped_run
            and held["boundary_request_key"] == stop_key
            and 0 < held["scope_sequence"] == intake["sequence"] <= held["through_scope_sequence"]
            and held["state"] != "consumed" and held["admitted_run_id"] is None,
            "held_input_provenance_changed")
    require(state["pending"][0]["message_id"] == intake["message_id"]
            and state["pending"][0]["event_id"] == intake["event_id"]
            and all(run["message_id"] != intake["message_id"] for run in state["runs"]),
            "held_input_was_dispatched")
    return held


def public_hold(candidate, path, held):
    code, page, headers = candidate.browser(path + "/held-inputs")
    require(code == 200 and "no-store" in headers.get("Cache-Control", ""), "held_input_read_unavailable")
    expected = {key: held[key] for key in ("message_id", "scope_sequence", "reason", "boundary_run_id",
                                          "boundary_event_id", "through_scope_sequence")}
    expected["source_event_id"] = held["event_id"]
    require(page["schema_version"] == 1 and page["conversation_id"] == path.rsplit("/", 1)[-1]
            and page["held"] == [expected] and page["next_after_sequence"] is None
            and page["eligible_input_available"] is False, "held_input_public_provenance_mismatch")


def exact_run(state, run_id, intake):
    runs = [run for run in state["runs"] if run["id"] == run_id]
    require(len(runs) == 1, "recovery_run_identity_missing")
    run = runs[0]
    require(run["message_id"] == intake["message_id"] and run["event_id"] == intake["event_id"]
            and run["attempt"] == 1 and run["role"] == "deep", "recovery_run_input_or_attempt_changed")
    return run


def normal_retirement(state, run, receipt, count):
    matches = [row for row in state["retirements"] if row["prior_run_id"] == run["id"]]
    require(len(state["retirements"]) == count and len(matches) == 1, "graceful_retirement_missing")
    retirement = matches[0]
    supervisors = [row for row in state["supervisors"] if row["context_id"] == run["context_id"]]
    require(len(supervisors) == 1, "retirement_supervisor_missing")
    require(retirement["context_id"] == run["context_id"]
            and retirement["incarnation_id"] == run["incarnation_id"] == supervisors[0]["incarnation_id"]
            and retirement["supervisor_generation"] == supervisors[0]["generation"]
            and retirement["session_id"] == run["session_id"]
            and retirement["binding_generation"] == run["binding_generation"]
            and retirement["acceptance_event_id"] == receipt["acceptance_event_id"]
            and retirement["retired_at_ms"] > 0, "graceful_retirement_provenance_mismatch")


def summary(state):
    runs = state["runs"]
    return {"runs": len(runs), "states": [run["state"] for run in runs],
            "single_attempts": all(run["attempt"] == 1 for run in runs),
            "sessions": len({run["session_id"] for run in runs}),
            "native_sessions": len({run["native_session_id"] for run in runs}),
            "native_identity_sha256": hashlib.sha256(runs[0]["native_session_id"].encode()).hexdigest()
                if runs else None,
            "incarnations": len({run["incarnation_id"] for run in runs}),
            "held": len(state["held"]), "pending": len(state["pending"]),
            "graceful_retirements": len(state["retirements"]),
            "accepted": state["accepted"], "cancellations": state["cancellations"],
            "controls": [control["state"] for control in state["controls"]]}
