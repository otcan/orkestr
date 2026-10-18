"""Independent ordinary HTTP oracle; synthetic config arrives only on stdin."""
import hashlib
import json
import sqlite3
import sys
import urllib.error
import urllib.request
import uuid

c = json.load(sys.stdin)
origin, token = c["origin"], c["cookie"]
base = f'/api/v2/conversations/{c["conversation"]}'
csrf = hashlib.sha256(("orkestr-v2-browser-csrf-v1:" + token).encode()).hexdigest()
tables = ("production_acceptances", "production_payloads", "production_cancellations",
          "production_control_outbox", "production_observations", "production_supervisors",
          "production_readiness", "production_runs", "production_run_leases", "reasoning_inbox",
          "session_bindings", "messages", "events", "outbox", "conversations", "execution_revisions")


def rows():
    with sqlite3.connect("file:" + c["database"] + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        result = {t: db.execute(f'SELECT * FROM "{t}" ORDER BY rowid').fetchall() for t in tables}
        db.commit()
        return result


def request(path, body=None, changes=None, method=None):
    headers = {"Cookie": "orkestr_v2_session=" + token, "Origin": origin,
               "x-orkestr-csrf": csrf, "Content-Type": "application/json"}
    for k, v in (changes or {}).items():
        if v is None:
            headers.pop(k, None)
        else:
            headers[k] = v
    req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(),
                                 method=method or ("GET" if body is None else "POST"), headers=headers)
    try:
        reply = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        reply = error
    with reply:
        raw = reply.read(131073)
        assert len(raw) <= 131072
        return reply.status, json.loads(raw) if raw else None, reply.headers


def refused(path, body, expected, changes=None):
    before = rows()
    status, _, _ = request(path, body, changes)
    assert status == expected, (path, status, expected)
    assert rows() == before, "refused HTTP request changed durable execution ledger"


body = {"run_id": c["run"], "completion_event_id": c["completion"],
        "expected_revision": c["revision"], "request_key": "independent-owner-http:1"}
# Both control surfaces must reject ambient/mixed authority without mutation.
for endpoint, payload in [(base + "/accept", body), (base + "/stop", {
        "run_id": c["run"], "expected_revision": c["revision"], "request_key": "independent-stop:1"})]:
    for changes, status in [({"Cookie": None}, 401), ({"x-orkestr-csrf": None}, 403),
                            ({"x-orkestr-csrf": "invalid"}, 403), ({"Origin": None}, 403),
                            ({"Origin": "null"}, 403), ({"Origin": "https://foreign.test"}, 403),
                            ({"Host": "foreign.test"}, 403),
                            ({"Authorization": "Bearer " + token}, 401)]:
        refused(endpoint, payload, status, changes)
    refused(endpoint, dict(payload, expected_revision=c["revision"] - 1), 409)
for mutation, code in [({"run_id": str(uuid.uuid4())}, 409),
                       ({"completion_event_id": str(uuid.uuid4())}, 409),
                       ({"request_key": ""}, 400), ({"owner_id": str(uuid.uuid4())}, 400)]:
    refused(base + "/accept", dict(body, **mutation), code)
refused(f'/api/v2/conversations/{uuid.uuid4()}/accept', body, 404)
status, projection, _ = request(base + "/execution")
assert status == 200 and projection["run_id"] == c["run"]
candidate = projection.get("acceptance_candidate")
if candidate is not None:
    assert candidate == {"run_id": c["run"], "completion_event_id": c["completion"]}
    assert projection["revision"] == c["revision"]
# A new HTTP request after refetch simulates retry/reload, not mounted browser proof.
status, receipt, headers = request(base + "/accept", body)
assert status == 200 and headers["Cache-Control"] == "no-store"
for field in ("run_id", "completion_event_id", "request_key"):
    assert receipt[field] == body[field]
assert receipt["requested_revision"] == c["revision"]
assert receipt["outcome"] == "succeeded" and receipt["revision"] > c["revision"]
committed = rows()
assert request(base + "/execution")[1]["phase"] == "completed"
for _ in range(2):
    assert request(base + "/accept", body)[:2] == (200, receipt)
    assert rows() == committed
refused(base + "/accept", dict(body, expected_revision=receipt["revision"]), 409)
refused(base + "/accept", dict(body, request_key="changed-key"), 409)
assert request("/api/v2/browser/session", method="DELETE")[0] == 204
refused(base + "/accept", body, 401)
print(json.dumps({"http_matrix": "passed", "candidate_projection": "passed" if candidate else "pending",
                  "wrong_owner": "pending: singleton owner store; no synthetic second-owner API",
                  "mounted_browser": "pending", "provider_execution": "pending"}))
