"""Actual owned HTTP read/removal of a scoped, removable progress payload."""
import hashlib
import json
import sys
import urllib.error
import urllib.request
import uuid

origin, conversation, payload = sys.argv[1:]
token = "ad" * 32
csrf = hashlib.sha256(("orkestr-v2-browser-csrf-v1:" + token).encode()).hexdigest()
path = f"/api/v2/conversations/{conversation}/payloads/{payload}"


def request(method="GET", changes=None, target=path):
    headers = {"Origin": origin, "Cookie": "orkestr_v2_session=" + token,
               "x-orkestr-csrf": csrf}
    for key, value in (changes or {}).items():
        if value is None:
            headers.pop(key, None)
        else:
            headers[key] = value
    req = urllib.request.Request(origin + target, method=method, headers=headers)
    try:
        reply = urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as error:
        reply = error
    with reply:
        raw = reply.read()
        if reply.status < 400:
            assert reply.headers["Cache-Control"] == "no-store"
        return reply.status, json.loads(raw) if raw else None


assert request(changes={"Cookie": None})[0] == 401
assert request(changes={"Authorization": "Bearer " + token})[0] == 401
assert request(target=f"/api/v2/conversations/{uuid.uuid4()}/payloads/{payload}")[0] == 404
status, body = request()
assert status == 200 and body["text"] == "synthetic progress <untrusted>"
assert body["payload_id"] == payload and body["conversation_id"] == conversation
for changes in [{"x-orkestr-csrf": None}, {"Origin": "https://foreign.test"},
                {"Host": "foreign.test"}]:
    assert request("DELETE", changes)[0] == 403
    assert request()[1] == body
assert request("DELETE") == (204, None)
assert request()[1] == dict(body, text=None)
assert request("DELETE") == (204, None)
assert request()[1]["text"] is None
