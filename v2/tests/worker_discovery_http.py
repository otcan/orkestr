"""Mounted browser Worker discovery, with an ordinary isolated synthetic server."""
import uuid

from owned_execution_http import Case, wait_for


def run():
    case = Case()
    try:
        case.setup()
        path = case.path + "/workers"
        assert case.request(path)[0] == 503
        assert case.request(path, browser=False)[0] == 401
        case.stop()
        case.configure()
        case.start(configured=True)
        wait_for(lambda: any(row["kind"] == "ready" for row in case.trace()),
                 "owned synthetic Deep setup")
        code, page, headers = case.request(path)
        assert code == 200 and page["conversation_id"] == case.conversation
        assert page["workers"] == [], "idle Deep is never fabricated as a Worker"
        assert headers["Cache-Control"] == "no-store"
        for suffix in ["?limit=0", "?limit=101", "?limit=1&limit=2",
                       "?after=invalid", "?owner=synthetic", "?provider_auth=synthetic"]:
            code, _, headers = case.request(path + suffix)
            assert code == 400 and headers["Cache-Control"] == "no-store"
        assert case.request(path, extra={"Host": "foreign.invalid"})[0] == 403
        assert case.request(path, extra={"Authorization": "Bearer " + case.machine})[0] == 401
        assert case.request(f"/api/v2/conversations/{uuid.uuid4()}/workers")[0] == 404
        assert case.message()[0] == 202
        wait_for(lambda: case.phase("awaiting_acceptance"), "synthetic Deep proposal")
        assert case.request(path)[1]["workers"] == []
        assert case.request("/api/v2/browser/session", "DELETE")[0] == 204
        assert case.request(path + "?limit=0")[0] == 401
    finally:
        case.cleanup()


if __name__ == "__main__":
    run()
    print("case passed: mounted_worker_discovery", flush=True)
