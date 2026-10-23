"""Policy failure closes through actual custody release, with no fallback/replay."""
from owned_execution_http import wait_for


def run(case, *, admit, expect, select_claude):
    select_claude(case, False)
    case.fixture.write_private(case.claude_workspace / "policy-refusal", b"1")
    window = admit(case, "policy:1", "synthetic policy refusal fixture")
    base = "/api/v2/conversations/" + case.conversation

    def closed():
        # Exercise the normal authenticated status/recovery path. No owner
        # abandonment decision, forced reset, new input or deadline advance.
        value = expect(case, base + "/window")
        return value if value["state"] == "closed" else None

    final = wait_for(closed, "policy-refused window cleanup and closure", 90)
    wait_for(lambda: [r["state"] for r in case.rows("SELECT state FROM windows", manager=True)] == ["retired"],
             "policy window manager cleanup", 30)
    runs = case.rows("SELECT id,role,state FROM production_runs ORDER BY rowid")
    assert runs and {row["state"] for row in runs} <= {"failed", "cancelled"}, runs
    assert not case.rows("SELECT * FROM production_acceptances"), "fallback must never be accepted"
    assert not case.rows("SELECT * FROM production_payloads"), "fallback text must never be exported"
    refusals = []
    for row in runs:
        route = "/fast/execution" if row["role"] == "fast" else "/execution"
        status = expect(case, base + route + "?run_id=" + row["id"])
        if (status.get("failure") or {}).get("class") == "policy":
            assert status["models"]["provider"] == "claude", status
            assert status["models"]["refused_model"] == "synthetic-selected-model", status
            assert not status["models"].get("actual_model"), status
            refusals.append(row["id"])
    assert refusals, runs
    trace = case.trace()
    assert len([r for r in trace if r["kind"] == "turn"]) == len(runs), "no automatic replay"
    # A policy failure does not authorize inventing a successful terminal or a
    # Stopped observation. Manager retirement is separate real cleanup proof.
    events = case.rows("SELECT kind FROM production_observations")
    assert {r["kind"] for r in events} <= {"started", "failed"}, events
    return {"window": window["window_id"], "final": final["state"], "runs": runs,
            "policy_runs": refusals, "replayed": False, "fallback_accepted": False}
