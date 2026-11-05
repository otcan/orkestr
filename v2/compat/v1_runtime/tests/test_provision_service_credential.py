"""Real synthetic HTTP exchanges and private files; no owner/provider state."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
import shutil

from v2.compat.v1_runtime.provision_service_credential import provision
from v2.compat.v1_runtime.rust_client import ClientError, credentials

OWNER = "00000000-0000-4000-8000-000000000001"
KEY = "00000000-0000-4000-8000-000000000002"
SOURCE = "a" * 40
SECRET = "c" * 64


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def do_PUT(self):
        self.dispatch()

    def dispatch(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append((self.command, self.path, dict(self.headers),
                                     json.loads(raw) if raw else None))
        status, value, headers = 200, {}, {}
        if self.path == "/api/v2/health":
            value = {"status": "ok", "product": "orkestr-v2", "fixture_mode": False,
                     "build": {"format": "orkestr-v2-build-identity-v1", "component": "server",
                               "source_commit": self.server.source}}
        elif self.command == "DELETE":
            token = self.headers.get("Cookie", "").split("=")[-1]
            csrf = hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{token}".encode()).hexdigest()
            if self.headers.get("Origin") != "https://example.test" or self.headers.get("X-Orkestr-CSRF") != csrf:
                status = 403
            else:
                status = 204
        elif self.path.endswith("service-credentials"):
            value = {"id": KEY, "service_token": SECRET, "expires_in": 2592000}
            if self.server.unknown_create:
                self.connection.close()
                return
        elif self.path.endswith("service-session") or self.path.endswith("browser/session"):
            service = self.path.endswith("service-session")
            if service and self.server.on_exchange:
                self.server.on_exchange()
            token = (self.headers.get("Cookie", "").split("=")[-1] if self.command == "GET"
                     else ("d" if service else "b") * 64)
            value = {"owner_id": OWNER,
                     "csrf_token": hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{token}".encode()).hexdigest()}
            headers["Set-Cookie"] = (f"orkestr_v2_session={token}; Path=/api/v2; HttpOnly; SameSite=Strict; Secure")
            if service and self.server.reject_service:
                status = 401
            if self.command == "GET" and getattr(self.server, "reject_cookie", False):
                status = 401
        else:
            status = 404
        body = b"" if status == 204 else json.dumps(value).encode()
        try:
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


@unittest.skipUnless(os.geteuid()==0,"Root-published provision peer fixture")
class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.root=Path('/orkestr-provision-test-'+str(uuid.uuid4()));self.root.mkdir(mode=0o755)
        self.private=self.root/'private';self.private.mkdir(mode=0o700)
        self.owner = self.root / "owner.json"
        self.owner_raw = json.dumps({"username": "synthetic-owner", "password": "synthetic-password-000000"})
        self.owner.write_text(self.owner_raw)
        self.owner.chmod(0o600)
        self.output = self.private / "adapter.json"
        from v2.compat.tests.peer_test_fixture import CorePeer
        self.server=CorePeer(self.root,Peer)
        descriptor=self.server.publish()
        self.options = dict(origin="https://example.test",
                            loopback_url=f"http://127.0.0.1:{self.server.server_port}",
                            credentials_path=str(self.owner), expected_owner=OWNER,
                            expected_source=SOURCE, output=str(self.output), label="synthetic-adapter",
                            timeout_s=1,peer_descriptor_path=str(descriptor))

    def tearDown(self):
        self.server.close();shutil.rmtree(self.root)

    def created(self):
        return [r for r in self.server.requests if r[:2] == ("POST", "/api/v2/browser/service-credentials")]

    def test_verifies_key_before_private_publication_and_preserves_owner_file(self):
        receipt = provision(**self.options)
        self.assertEqual(receipt["status"], "provisioned-not-activated")
        self.assertNotIn(SECRET, json.dumps(receipt))
        self.assertEqual(credentials(self.output), {"service_token": SECRET})
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.output.stat().st_nlink, 1)
        self.assertEqual(self.owner.read_text(), self.owner_raw)
        exchange = next(r for r in self.server.requests if r[1].endswith("service-session"))
        self.assertNotIn("Origin", exchange[2])
        self.assertEqual(exchange[3], {"service_token": SECRET})
        self.assertEqual(len(self.created()), 1)
        deletes = [r for r in self.server.requests if r[0] == "DELETE"]
        self.assertEqual(len(deletes), 2)  # Verify + human cookies both logged out.
        self.assertTrue(all("X-Orkestr-CSRF" in r[2] for r in deletes))
        self.assertFalse(list(self.private.glob("*.tmp")))

    def test_existing_output_or_symlink_refused_before_network(self):
        self.output.symlink_to(self.owner)
        with self.assertRaisesRegex(ClientError, "output_exists"):
            provision(**self.options)
        self.assertEqual(self.server.requests, [])
        self.assertEqual(self.owner.read_text(), self.owner_raw)

    def test_source_mismatch_prevents_login_and_key_creation(self):
        self.server.source = "e" * 40
        with self.assertRaisesRegex(ClientError, "source_mismatch"):
            provision(**self.options)
        self.assertFalse(any(r[0] == "POST" for r in self.server.requests))
        self.assertFalse(self.output.exists())

    def test_unusable_key_is_revoked_without_publishing(self):
        self.server.reject_service = True
        with self.assertRaisesRegex(ClientError, "provision_failed_key_revoked"):
            provision(**self.options)
        self.assertFalse(self.output.exists())
        self.assertEqual(len(self.created()), 1)
        self.assertTrue(any(r[:2] == ("DELETE", f"/api/v2/browser/service-credentials/{KEY}")
                            for r in self.server.requests))
        self.assertFalse(list(self.private.glob("*.tmp")))

    def test_concurrent_output_creator_is_preserved_and_new_key_revoked(self):
        self.server.on_exchange = lambda: self.output.write_text("other operator's file")
        with self.assertRaisesRegex(ClientError, "provision_failed_key_revoked"):
            provision(**self.options)
        self.assertEqual(self.output.read_text(), "other operator's file")
        self.assertTrue(any(r[:2] == ("DELETE", f"/api/v2/browser/service-credentials/{KEY}")
                            for r in self.server.requests))
        self.assertFalse(list(self.private.glob("*.tmp")))

    def test_unknown_create_is_not_retried_or_reported_success(self):
        self.server.unknown_create = True
        with self.assertRaisesRegex(ClientError, "provision_failed_review_required"):
            provision(**self.options)
        self.assertEqual(len(self.created()), 1)
        self.assertFalse(self.output.exists())

    def test_non_private_output_directory_refused_before_network(self):
        self.private.chmod(0o750)
        with self.assertRaisesRegex(ClientError, "output_directory_not_private"):
            provision(**self.options)
        self.assertEqual(self.server.requests, [])


if __name__ == "__main__":
    unittest.main()
