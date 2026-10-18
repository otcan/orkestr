"""Actual cookie/CSRF HTTP controls against a trusted, synthetic bound server."""
import hashlib
import json
import sys
import urllib.error
import urllib.request
import uuid

origin, conversation, run, revision, completion = sys.argv[1:]
revision = int(revision)
token = "ad" * 32
csrf = hashlib.sha256(("orkestr-v2-browser-csrf-v1:" + token).encode()).hexdigest()
path = f"/api/v2/conversations/{conversation}/accept"
body = {"run_id": run, "expected_revision": revision, "request_key": "accept:1", "completion_event_id": completion}


def request(payload, changes=None, target=path):
    headers = {"Content-Type": "application/json", "Origin": origin,
               "Cookie": "orkestr_v2_session=" + token, "x-orkestr-csrf": csrf}
    for key, value in (changes or {}).items():
        if value is None:
            headers.pop(key, None)
        else:
            headers[key] = value
    req = urllib.request.Request(origin + target, method="POST", headers=headers,
                                 data=json.dumps(payload).encode())
    try:
        reply = urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as error:
        reply = error
    with reply:
        return reply.status, json.loads(reply.read()), reply.headers


status_request = urllib.request.Request(origin + f"/api/v2/conversations/{conversation}/execution", headers={"Cookie": "orkestr_v2_session=" + token})
with urllib.request.urlopen(status_request, timeout=5) as reply:
    projection = json.load(reply)
assert projection["revision"] == revision
assert projection["acceptance_candidate"] == {"run_id": run, "completion_event_id": completion}

for headers, status in [({"x-orkestr-csrf": None}, 403),
                        ({"Origin": "https://foreign.test"}, 403),
                        ({"Host": "foreign.test"}, 403),
                        ({"Authorization": "Bearer " + token}, 401),
                        ({"Cookie": None}, 401)]:
    actual = request(body, headers)
    assert actual[0] == status, (list(headers), actual[0], status, actual[1])
for mutation in [{"expected_revision": -1}, {"request_key": ""},
                 {"run_id": None}, {"extra": "refused"}]:
    assert request(dict(body, **mutation))[0] == 400
assert request(dict(body, expected_revision=revision - 1))[0] == 409
assert request(body, target=f"/api/v2/conversations/{uuid.uuid4()}/accept")[0] == 404
status, receipt, headers = request(body)
assert status == 200, (status, receipt)
assert headers["Cache-Control"] == "no-store"
assert receipt == {"schema_version": 1, "conversation_id": conversation,
                   "run_id": run, "request_key": "accept:1",
                   "completion_event_id": completion, "acceptance_event_id": receipt["acceptance_event_id"],
                   "requested_revision": revision, "revision": receipt["revision"],
                   "outcome": "succeeded"}
assert receipt["revision"] > revision
assert request(body)[:2] == (200, receipt)
assert request(dict(body, expected_revision=receipt["revision"]))[0] == 409
assert request(body)[:2] == (200, receipt)
print("Acceptance HTTP auth/refusal/replay matrix PASS")

logout = urllib.request.Request(origin + "/api/v2/browser/session", method="DELETE", headers={
    "Origin": origin, "Cookie": "orkestr_v2_session=" + token, "x-orkestr-csrf": csrf})
with urllib.request.urlopen(logout, timeout=5) as reply:
    assert reply.status == 204
assert request(body)[0] == 401, "revocation must fence historical acceptance replay"
