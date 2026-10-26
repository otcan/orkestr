"""Synthetic loopback peers only. No actual owner credentials or provider."""
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from v2.compat.v1_runtime import rust_client as client_module
from v2.compat.v1_runtime.rust_client import ClientError, RustClient, RustSession

OWNER = "00000000-0000-4000-8000-000000000001"
CONVERSATION = "00000000-0000-4000-8000-000000000002"
MESSAGE = "00000000-0000-4000-8000-000000000003"
EVENT = "00000000-0000-4000-8000-000000000004"
RUN = "00000000-0000-4000-8000-000000000005"
WINDOW = "00000000-0000-4000-8000-000000000006"
SOURCE = "a" * 40
TOKEN = "b" * 64
CSRF = hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{TOKEN}".encode()).hexdigest()
ORIGIN = "https://example.test"
PREFIX = f"/api/v2/conversations/{CONVERSATION}"
OTHER = "00000000-0000-4000-8000-000000000007"
INTAKE = dict(message_id=MESSAGE, event_id=EVENT, sequence=4, status="accepted")


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def dispatch(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.observed.append((self.command, self.path, dict(self.headers),
                                     json.loads(body) if body else None))
        status, value, headers = self.server.respond(self.command, self.path)
        content = value if isinstance(value, bytes) else json.dumps(value).encode()
        try:
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            if "Content-Type" not in headers:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rust-client-synthetic-")
        self.root = Path(self.temporary.name)
        self.secret = self.root / "owner.json"
        self.secret.write_text(json.dumps({"username": "synthetic-owner",
                                          "password": "synthetic-password-000000000000"}))
        self.secret.chmod(0o600)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
        self.server.daemon_threads = False
        self.server.observed = []
        self.server.respond = self.respond
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.client = RustClient(origin=ORIGIN, loopback_url=f"http://127.0.0.1:{self.server.server_port}",
                                 credentials_path=self.secret, expected_owner=OWNER,
                                 conversation_id=CONVERSATION, expected_source=SOURCE, timeout_s=0.3)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def respond(self, method, path):
        if path == "/api/v2/health":
            return 200, {"status": "ok", "product": "orkestr-v2", "fixture_mode": False,
                         "build": {"format": "orkestr-v2-build-identity-v1", "component": "server",
                                   "source_commit": SOURCE}}, {}
        if path == client_module.SESSION:
            headers = {}
            if method == "POST":
                headers["Set-Cookie"] = (f"orkestr_v2_session={TOKEN}; Path=/api/v2; HttpOnly; "
                                         "Secure; SameSite=Strict; Max-Age=43200")
            return 200, {"owner_id": OWNER, "global_conversation_id": CONVERSATION, "csrf_token": CSRF}, headers
        if path == PREFIX:
            return 200, {"conversation_id": CONVERSATION, "messages": [], "last_sequence": 0}, {}
        if path == PREFIX + "/messages":
            return 202, INTAKE, {}
        if path == PREFIX + "/window":
            return 204, b"", {}
        if path == f"/api/v2/conversations/{OTHER}":
            return 200, {"conversation_id": OTHER, "messages": [], "last_sequence": 0}, {}
        if path == PREFIX + "/attachment-imports" and method == "POST":
            request = self.server.observed[-1][3]
            return 200, {"import_id": RUN, "manifest": request["target_manifest"], "mapping": request["mapping"],
                         "source_manifest_id": request["source"]["manifest"]["manifest_id"]}, {}
        return 404, {"error": {"code": "not_found"}}, {}

    def posts(self, path):
        return [row for row in self.server.observed if row[0] == "POST" and row[1] == path]

    def test_normal_login_origin_csrf_and_only_selected_intake(self):
        status, value = self.client.request("POST", "/messages",
                                           {"client_message_id": "source:1", "text": "synthetic"}, (202,))
        self.assertEqual((status, value), (202, INTAKE))
        self.assertEqual(len(self.posts(client_module.SESSION)), 1)
        self.assertEqual(self.client.request("GET", "/window", allowed=(200, 204)), (204, None))
        self.assertEqual(len(self.posts(client_module.SESSION)), 1)
        for method, path, headers, _ in self.server.observed:
            self.assertEqual(headers["Host"], "example.test")
            self.assertNotIn("Authorization", headers)
            if path == "/api/v2/health":
                self.assertNotIn("Cookie", headers)
            if method == "POST":
                self.assertEqual(headers["Origin"], ORIGIN)
        headers = self.posts(PREFIX + "/messages")[0][2]
        self.assertEqual(headers["Cookie"], f"orkestr_v2_session={TOKEN}")
        self.assertEqual(headers["X-Orkestr-CSRF"], CSRF)

    def test_source_drift_prevents_credentials_and_later_mutation(self):
        original = self.respond
        def mismatch(method, path):
            status, value, headers = original(method, path)
            if path == "/api/v2/health":
                value["build"]["source_commit"] = "c" * 40
            return status, value, headers
        self.server.respond = mismatch
        with patch.object(client_module, "credentials", side_effect=AssertionError("must not read")):
            with self.assertRaisesRegex(ClientError, "source_mismatch"):
                self.client.ensure_login()
        self.assertEqual(self.posts(client_module.SESSION), [])
        self.server.respond = original
        self.client.ensure_login()
        self.server.respond = mismatch
        with self.assertRaisesRegex(ClientError, "source_mismatch"):
            self.client.request("POST", "/messages", {}, (202,))
        self.assertEqual(self.posts(PREFIX + "/messages"), [])

    def test_revocation_refuses_without_relogin_or_mutation(self):
        self.client.ensure_login()
        original = self.respond
        self.server.respond = lambda method, path: ((401, {"secret": "not logged"}, {})
                                                    if path == client_module.SESSION else original(method, path))
        for _ in range(2):
            with self.assertRaisesRegex(ClientError, "session_revoked"):
                self.client.request("POST", "/messages", {}, (202,))
        self.assertEqual(len(self.posts(client_module.SESSION)), 1)
        self.assertEqual(self.posts(PREFIX + "/messages"), [])

    def test_an_aging_session_is_renewed_before_the_server_expires_it(self):
        self.client.request("POST", "/messages", {"client_message_id": "k", "text": "t"}, (202,))
        generation = self.client.session.generation
        self.client.session._logged_in_at -= client_module.SESSION_RENEW_S - 60
        self.client.request("POST", "/messages", {"client_message_id": "k", "text": "t"}, (202,))
        self.assertEqual(len(self.posts(client_module.SESSION)), 1, "a young session is reused")
        self.client.session._logged_in_at -= 60
        self.client.request("POST", "/messages", {"client_message_id": "k", "text": "t"}, (202,))
        self.assertEqual(len(self.posts(client_module.SESSION)), 2, "an old session logs in again")
        self.assertEqual(self.client.session.generation, generation + 1)
        self.assertFalse(self.client._revoked)

    def test_an_aging_session_is_renewed_by_an_idle_read(self):
        self.client.ensure_login()
        self.client.session._logged_in_at -= client_module.SESSION_RENEW_S
        self.assertEqual(self.client.request("GET", "/window", allowed=(200, 204)), (204, None))
        self.assertEqual(len(self.posts(client_module.SESSION)), 2)

    def checks(self):
        return len([row for row in self.server.observed if row[1] == "/api/v2/health"])

    def test_reads_reuse_a_recent_check_and_mutations_always_recheck(self):
        self.client.ensure_login()
        self.assertEqual(self.checks(), 1)
        for _ in range(3):
            self.assertEqual(self.client.request("GET", "/window", allowed=(200, 204)), (204, None))
        self.assertEqual(self.checks(), 1, "idle reads reuse the recent server identity and session check")
        self.client.request("POST", "/messages", {"client_message_id": "k", "text": "t"}, (202,))
        self.assertEqual(self.checks(), 2, "a mutation always rechecks first")
        self.client.session._verified_at -= client_module.READ_RECHECK_S
        self.client.request("GET", "/window", allowed=(200, 204))
        self.assertEqual(self.checks(), 3, "an old check is renewed before a read")
        self.assertEqual(len(self.posts(client_module.SESSION)), 1)

    def test_a_transport_failure_rechecks_before_the_next_read(self):
        self.client.ensure_login()
        original = self.respond
        self.server.respond = lambda method, path: ((302, b"", {"Location": "/"}) if path == PREFIX + "/window"
                                                    else original(method, path))
        with self.assertRaises(ClientError):
            self.client.request("GET", "/window", allowed=(200, 204))
        self.assertIsNotNone(self.client.session._verified_at, "a definite status keeps the check")
        self.server.respond = original
        self.client.session.port = 1  # Nothing listens: the transport fails.
        with self.assertRaisesRegex(ClientError, "transport_failed"):
            self.client.request("GET", "/window", allowed=(200, 204))
        self.assertIsNone(self.client.session._verified_at)
        self.client.session.port = self.server.server_port
        before = self.checks()
        self.client.request("GET", "/window", allowed=(200, 204))
        self.assertEqual(self.checks(), before + 1)

    def test_source_drift_is_seen_by_reads_within_the_recheck_interval(self):
        self.client.ensure_login()
        original = self.respond
        def mismatch(method, path):
            status, value, headers = original(method, path)
            if path == "/api/v2/health":
                value["build"]["source_commit"] = "c" * 40
            return status, value, headers
        self.server.respond = mismatch
        self.client.session._verified_at -= client_module.READ_RECHECK_S
        with self.assertRaisesRegex(ClientError, "source_mismatch"):
            self.client.request("GET", "/window", allowed=(200, 204))
        self.assertFalse(any(row[1] == PREFIX + "/window" for row in self.server.observed))

    def test_wrong_owner_and_csrf_projection_refuse(self):
        for field, value in (("owner_id", RUN), ("csrf_token", "c" * 64)):
            with self.subTest(field=field):
                original = self.respond
                def wrong(method, path):
                    status, body, headers = original(method, path)
                    if path == client_module.SESSION:
                        body[field] = value
                    return status, body, headers
                self.server.respond = wrong
                self.client._revoked = False
                with self.assertRaisesRegex(ClientError, "session_scope_mismatch"):
                    self.client.ensure_login()
                self.assertIsNone(self.client._cookie)

    def test_foreign_paths_and_malformed_queries_never_reach_peer(self):
        for suffix in ("//elsewhere.test/api", "https://elsewhere.test", "/../messages",
                       "/messages?run_id=" + RUN, "/execution?run_id=bad",
                       "/execution?run_id=" + RUN + "&run_id=" + RUN,
                       "/accepted-results?limit=101", "/payloads/%2e%2e",
                       "/timer-inputs?after=1", "/timer-inputs?limit=101", "/timer-inputs?after_sequence=-1",
                       "/posts?pending=false", "/posts?pending=1", "/posts?after_ms=1", "/posts?limit=101"):
            with self.subTest(suffix=suffix), self.assertRaises(ClientError):
                self.client.request("GET", suffix)
        self.assertEqual(self.server.observed, [])
        for suffix in ("/posts/not-a-uuid/delivered", "/posts/" + RUN, "/posts"):
            with self.subTest(suffix=suffix), self.assertRaises(ClientError):
                self.client.request("POST", suffix, body={})
        self.assertEqual(self.server.observed, [])

    def test_steer_routes_are_exact(self):
        for method, suffix in (("GET", "/steer"), ("POST", "/steering/auto-steer:x"), ("GET", "/steering/a b"),
                               ("GET", "/steering/" + "k" * 129), ("GET", "/steering/x?limit=1"),
                               ("POST", "/inputs/not-a-uuid/retire"), ("GET", "/inputs/%s/retire" % RUN),
                               ("POST", "/inputs/%s" % RUN), ("POST", "/steer?run_id=" + RUN)):
            with self.subTest(method=method, suffix=suffix), self.assertRaises(ClientError):
                self.client._path(method, suffix)
        for method, suffix in (("POST", "/steer"), ("GET", "/steering/auto-steer:" + RUN),
                               ("POST", "/inputs/%s/retire" % RUN)):
            self.assertTrue(self.client._path(method, suffix).endswith(suffix))

    def test_redirect_scope_type_and_body_bounds_are_refused(self):
        self.client.ensure_login()
        original = self.respond
        cases = [(302, b"", {"Location": "https://elsewhere.test/"}),
                 (200, {"conversation_id": RUN}, {}),
                 (200, b"{}", {"Content-Type": "text/html"}),
                 (200, b"x" * (client_module.MAX_BODY + 1), {}),
                 (200, b'{"conversation_id":"x","conversation_id":"y"}', {})]
        for reply in cases:
            with self.subTest(status=reply[0], size=len(reply[1])):
                self.server.respond = lambda method, path: (reply if path == PREFIX + "/execution"
                                                           else original(method, path))
                with self.assertRaises(ClientError):
                    self.client.request("GET", "/execution", allowed=(200, 302))
        self.assertFalse(any("elsewhere" in row[1] for row in self.server.observed))

    def test_dummy_credential_alias_permissions_and_hardlink_refuse(self):
        self.secret.chmod(0o644)
        with self.assertRaisesRegex(ClientError, "credential_file_refused"):
            client_module.credentials(self.secret)
        self.secret.chmod(0o600)
        alias = self.root / "alias.json"
        alias.symlink_to(self.secret)
        with self.assertRaisesRegex(ClientError, "credential_file_refused"):
            client_module.credentials(alias)
        alias.unlink()
        os.link(self.secret, alias)
        with self.assertRaisesRegex(ClientError, "credential_file_refused"):
            client_module.credentials(self.secret)

    def test_failed_login_does_not_include_body_or_secret_in_error(self):
        original = self.respond
        self.server.respond = lambda method, path: ((403, {"error": self.secret.read_text()}, {})
                                                    if path == client_module.SESSION else original(method, path))
        with self.assertRaises(ClientError) as caught:
            self.client.ensure_login()
        self.assertEqual(str(caught.exception), "unexpected_status:403")
        self.assertNotIn("synthetic-password", repr(caught.exception))

    def test_header_deadline_is_finite(self):
        original = self.respond
        self.server.respond = lambda method, path: (time.sleep(0.5) or original(method, path))
        start = time.monotonic()
        with self.assertRaisesRegex(ClientError, "transport_failed"):
            self.client.ensure_login()
        self.assertLess(time.monotonic() - start, 0.8)

    def event(self, sequence, *, message=MESSAGE, event=EVENT, run=RUN):
        return dict(owner_id=OWNER, aggregate_id=CONVERSATION, sequence=sequence, schema_version=5,
                    source_message_id=message, source_event_id=event,
                    payload_ref_or_safe_payload={"kind": "provider_observed", "run_id": run,
                                                "observation": {"kind": "started"}})

    def test_sse_source_correlation_and_cursor_are_exact(self):
        values = [self.event(5), self.event(6, message=WINDOW)]
        body = b": keepalive\n\n" + b"".join(
            f"id: {row['sequence']}\nevent: provider_observed\ndata: {json.dumps(row)}\n\n".encode()
            for row in values)
        original = self.respond
        self.server.respond = lambda method, path: ((200, body, {"Content-Type": "text/event-stream"})
                                                    if "/events?" in path else original(method, path))
        events = self.client.read_events(4)
        self.assertEqual([event["sequence"] for event in events], [5, 6])
        self.assertEqual(self.client.matching_run_ids(events, INTAKE), [RUN])
        self.assertEqual(len(self.client.read_events(4, maximum=1)), 1)
        wrong = self.event(5)
        wrong["aggregate_id"] = RUN
        bad = f"id: 5\nevent: provider_observed\ndata: {json.dumps(wrong)}\n\n".encode()
        self.server.respond = lambda method, path: ((200, bad, {"Content-Type": "text/event-stream"})
                                                    if "/events?" in path else original(method, path))
        with self.assertRaisesRegex(ClientError, "event_scope_mismatch"):
            self.client.read_events(4)

    def test_event_read_deadline_is_bounded_without_changing_authentication_or_correlation(self):
        value = self.event(5)
        raw = f"id: 5\nevent: provider_observed\ndata: {json.dumps(value)}\n\n".encode()
        original = self.respond
        self.server.respond = lambda method, path: ((200, raw, {"Content-Type": "text/event-stream"})
                                                    if "/events?" in path else original(method, path))
        with patch.object(self.client, "_wire", wraps=self.client._wire) as wire:
            events = self.client.read_events(4, timeout_s=0.15)
        self.assertEqual(self.client.matching_run_ids(events, INTAKE), [RUN])
        event_calls = [call for call in wire.call_args_list if "/events?" in call.args[1]]
        self.assertEqual(event_calls[0].kwargs["timeout_s"], 0.15)
        self.assertEqual(len(self.posts(client_module.SESSION)), 1)
        with patch.object(self.client, "_wire", wraps=self.client._wire) as wire:
            self.client.read_events(4, timeout_s=2)
        self.assertEqual(wire.call_args.kwargs["timeout_s"], self.client.session.timeout_s,
                         "an event wait cannot extend the client's configured deadline")
        for invalid in (0, -1, True, "0.15", float("nan"), 21):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ClientError, "event_deadline_refused"):
                self.client.read_events(4, timeout_s=invalid)

    def test_window_tuple_matches_ui_first_active_closed_and_refuses_drift(self):
        first = self.client.window_request(INTAKE, "input:1", "window:1", None)
        self.assertEqual((first["expected_generation"], first["window_id"], first["predecessor_window_id"]),
                         (0, None, None))
        window = dict(conversation_id=CONVERSATION, window_id=WINDOW, generation=1, state="active",
                      opened_at_ms=1000, work_deadline_ms=871000, expires_at_ms=901000,
                      limits=client_module.LIMITS.copy())
        active = self.client.window_request(INTAKE, "input:1", "window:1", window)
        self.assertEqual((active["expected_generation"], active["window_id"], active["predecessor_window_id"]),
                         (1, WINDOW, None))
        # An extended window keeps its exact 30-second cleanup margin.
        extended = dict(window, work_deadline_ms=3571000, expires_at_ms=3601000)
        self.assertEqual(self.client.window_request(INTAKE, "input:1", "window:1", extended)["window_id"], WINDOW)
        for work, end in ((3571000, 3600000), (14371001, 14401001), (870999, 900999)):
            with self.subTest(work=work), self.assertRaises(ClientError):
                self.client.window_request(INTAKE, "input:1", "window:1",
                                           dict(window, work_deadline_ms=work, expires_at_ms=end))
        window["state"] = "closed"
        closed = self.client.window_request(INTAKE, "input:1", "window:1", window)
        self.assertEqual((closed["expected_generation"], closed["window_id"], closed["predecessor_window_id"]),
                         (1, None, WINDOW))
        for key, value in (("state", "opening"), ("state", "reconciliation_required"),
                           ("conversation_id", RUN), ("generation", True), ("work_deadline_ms", 1),
                           ("limits", dict(client_module.LIMITS, attempts=33))):
            bad = copy.deepcopy(window)
            bad[key] = value
            with self.subTest(key=key), self.assertRaises(ClientError):
                self.client.window_request(INTAKE, "input:1", "window:1", bad)

    def test_bindings_share_one_login_and_scope_failures_stay_local(self):
        session = self.client.session
        other = RustClient(conversation_id=OTHER, session=session)
        wrong = RustClient(conversation_id=WINDOW, session=session)
        self.client.ensure_login()
        other.ensure_login()
        self.assertEqual(len(self.posts(client_module.SESSION)), 1)
        with self.assertRaises(ClientError):
            wrong.ensure_login()
        with self.assertRaisesRegex(ClientError, "conversation_scope_mismatch"):
            wrong.request("POST", "/messages", {}, (202,))
        self.assertEqual(self.client.request("POST", "/messages", {"client_message_id": "k", "text": "t"}, (202,))[0], 202)
        self.assertFalse(any(path.startswith(f"/api/v2/conversations/{WINDOW}/") for _, path, _, _ in self.server.observed))
        self.assertIsInstance(session, RustSession)

    def test_one_bindings_event_wait_does_not_stall_another_binding(self):
        other = RustClient(conversation_id=OTHER, session=self.client.session)
        self.client.ensure_login()
        other.ensure_login()
        waiting, release = threading.Event(), threading.Event()
        original = self.respond

        def respond(method, path):
            if path.startswith(PREFIX + "/events?"):
                waiting.set()
                release.wait(0.25)  # A caught-up stream: nothing to send yet.
                return 200, b": keepalive\n\n", {"Content-Type": "text/event-stream"}
            if path == f"/api/v2/conversations/{OTHER}/window":
                return 204, b"", {}
            return original(method, path)
        self.server.respond = respond
        reader = threading.Thread(target=self.client.read_events, args=(4,))
        reader.start()
        try:
            self.assertTrue(waiting.wait(2))
            start = time.monotonic()
            self.assertEqual(other.request("GET", "/window", allowed=(200, 204)), (204, None))
            elapsed = time.monotonic() - start
            self.assertFalse(release.is_set())
            self.assertLess(elapsed, 0.2, "another binding's read waits for this binding's event wait")
        finally:
            release.set()
            reader.join()
        self.assertEqual(len(self.posts(client_module.SESSION)), 1, "the bindings still share one login")

    def test_a_401_for_a_session_renewed_meanwhile_is_not_a_revocation(self):
        self.client.ensure_login()
        session, original = self.client.session, self.respond

        def renewed_during_request(method, path):
            if path == PREFIX + "/window":
                # Another binding renewed the shared session while this
                # request carried the previous cookie.
                session._cookie = "orkestr_v2_session=" + "c" * 64
                return 401, {"error": "stale"}, {}
            return original(method, path)
        self.server.respond = renewed_during_request
        with self.assertRaisesRegex(ClientError, "transport_failed"):
            self.client.request("GET", "/window", allowed=(200, 204))
        self.assertFalse(self.client._revoked)
        self.assertEqual(session._cookie, "orkestr_v2_session=" + "c" * 64)
        # A 401 for the current session is still a revocation.
        self.server.respond = lambda method, path: ((401, {"error": "revoked"}, {}) if path == PREFIX + "/window"
                                                    else original(method, path))
        with self.assertRaisesRegex(ClientError, "session_revoked"):
            self.client.request("GET", "/window", allowed=(200, 204))
        self.assertTrue(self.client._revoked)
        self.assertIsNone(session._cookie)

    def test_a_failed_renewal_never_sends_another_bindings_request_unauthenticated(self):
        self.client.ensure_login()
        session, original = self.client.session, self.respond
        session._logged_in_at -= client_module.SESSION_RENEW_S
        self.server.respond = lambda method, path: ((503, {}, {}) if path == "/api/v2/health"
                                                    else (401, {}, {}) if path == PREFIX + "/window"
                                                    else original(method, path))
        with self.assertRaisesRegex(ClientError, "unexpected_status"):
            self.client.ensure_login()  # The renewal fails after dropping the aging cookie.
        self.assertIsNone(session._cookie)
        sent = len(self.server.observed)
        # Another binding passed its login check before the failed renewal.
        with self.assertRaisesRegex(ClientError, "transport_failed"):
            self.client._wire("GET", PREFIX + "/window", allowed=(200, 204))
        self.assertEqual(len(self.server.observed), sent, "nothing is sent without the session cookie")
        self.assertFalse(session._revoked)
        self.server.respond = original
        self.assertEqual(self.client.request("GET", "/window", allowed=(200, 204)), (204, None))
        self.assertEqual(len(self.posts(client_module.SESSION)), 2, "the next request logs in again")

    def test_attachment_import_is_conversation_pinned_and_receipt_checked(self):
        reference = dict(reference_id=MESSAGE, message_id=None, filename="a.txt", media_type="text/plain",
                         byte_length=1, sha256=hashlib.sha256(b"a").hexdigest(), state="available")
        manifest = dict(schema_version=1, manifest_id=EVENT, owner_id=OWNER, conversation_id=RUN, references=[reference])
        target = dict(manifest, manifest_id=WINDOW, conversation_id=CONVERSATION,
                      references=[dict(reference, reference_id=OTHER)])
        request = dict(request_key="k", source=dict(manifest=manifest, contents=[dict(reference_id=MESSAGE, bytes=[97])]),
                       target_manifest=target, mapping=[dict(source_reference_id=MESSAGE, target_reference_id=OTHER)])
        self.assertEqual(self.client.import_attachments(request)["import_id"], RUN)
        headers = self.posts(PREFIX + "/attachment-imports")[0][2]
        self.assertEqual(headers["X-Orkestr-CSRF"], CSRF)
        with self.assertRaisesRegex(ClientError, "attachment_scope_refused"):
            self.client.import_attachments(dict(request, target_manifest=dict(target, conversation_id=OTHER)))


if __name__ == "__main__":
    unittest.main()
