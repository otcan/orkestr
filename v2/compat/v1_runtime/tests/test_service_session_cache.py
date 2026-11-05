"""Private cached service cookies, actual loopback protocol, no real secrets."""
from http.server import ThreadingHTTPServer
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
import shutil

from v2.compat.v1_runtime.rust_client import ClientError
from v2.compat.v1_runtime.service_session_cache import ServiceSessionCache
from v2.compat.v1_runtime.tests.test_provision_service_credential import Peer, OWNER, SOURCE, SECRET


@unittest.skipUnless(os.geteuid()==0,"Root-published service peer fixture")
class CacheTests(unittest.TestCase):
    def setUp(self):
        self.root=Path('/orkestr-cache-test-'+str(uuid.uuid4()));self.root.mkdir(mode=0o755)
        self.private=self.root/'private';self.private.mkdir(mode=0o700)
        self.key = self.root / "service.json"
        self.key.write_text(json.dumps({"service_token": SECRET}))
        self.key.chmod(0o600)
        self.cache = self.private / "cache.json"
        from v2.compat.tests.peer_test_fixture import CorePeer
        self.server=CorePeer(self.root,Peer)
        descriptor=self.server.publish()
        self.options = dict(origin="https://example.test",
                            loopback_url=f"http://127.0.0.1:{self.server.server_port}",
                            credentials_path=str(self.key), expected_owner=OWNER,
                            expected_source=SOURCE, timeout_s=1, peer_descriptor_path=str(descriptor))

    def tearDown(self):
        self.server.close();shutil.rmtree(self.root)

    def context(self, **extra):
        return ServiceSessionCache(self.cache, **(self.options | extra))

    def exchanges(self):
        return [r for r in self.server.requests if r[:2] == ("POST", "/api/v2/machine/service-session")]

    def test_repeated_commands_share_cookie_but_recheck_source_owner_and_session(self):
        for _ in range(3):
            with self.context() as client:
                self.assertTrue(client._cookie)
                self.assertTrue(self.cache.exists())  # Durable before caller mutation.
        self.assertEqual(len(self.exchanges()), 1)
        self.assertGreaterEqual(len([r for r in self.server.requests if r[1].endswith("browser/session")]), 2)
        self.assertEqual(self.cache.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(SECRET, self.cache.read_text())

    def test_observed_revocation_cannot_be_bypassed_by_a_new_command(self):
        with self.context():
            pass
        self.server.reject_cookie = True
        for _ in range(2):
            with self.assertRaisesRegex(ClientError, "session_revoked"):
                with self.context():
                    self.fail("revoked cookie admitted")
        self.assertEqual(len(self.exchanges()), 1)
        self.assertTrue(json.loads(self.cache.read_text())["revoked"])

    def test_explicit_key_replacement_recovers_without_replaying_any_operation(self):
        with self.context():
            pass
        self.server.reject_cookie = True
        with self.assertRaises(ClientError):
            with self.context():
                pass
        self.server.reject_cookie = False
        self.key.write_text(json.dumps({"service_token": "e" * 64}))
        with self.context() as client:
            self.assertFalse(client._revoked)
        self.assertEqual(len(self.exchanges()), 2)
        self.assertFalse(any(r[1].endswith("/messages") for r in self.server.requests))

    def test_source_drift_refuses_before_cached_cookie_is_sent(self):
        with self.context():
            pass
        count = len(self.server.requests)
        self.server.source = "e" * 40
        with self.assertRaisesRegex(ClientError, "source_mismatch"):
            with self.context():
                pass
        self.assertEqual([r[1] for r in self.server.requests[count:]], ["/api/v2/health"])

    def test_human_credential_cache_is_refused_without_login(self):
        self.key.write_text(json.dumps({"username": "synthetic", "password": "synthetic-password-000000"}))
        with self.assertRaisesRegex(ClientError, "service_credentials_required"):
            with self.context():
                pass
        self.assertEqual(self.server.requests, [])

    def test_symlink_or_corrupt_cache_never_creates_another_session(self):
        self.cache.symlink_to(self.key)
        with self.assertRaises(OSError):
            with self.context():
                pass
        self.cache.unlink()
        self.cache.write_text("{}")
        self.cache.chmod(0o600)
        with self.assertRaisesRegex(ClientError, "session_cache_shape_refused"):
            with self.context():
                pass
        self.assertEqual(self.server.requests, [])

    def test_parallel_commands_serialize_and_exchange_once(self):
        barrier = threading.Barrier(3)
        failures = []
        def run():
            try:
                barrier.wait(timeout=2)
                with self.context():
                    pass
            except BaseException as error:
                failures.append(type(error).__name__)
        threads = [threading.Thread(target=run) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait(timeout=2)
        for thread in threads:
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(self.exchanges()), 1)

    def test_cache_lock_timeout_does_not_send_credentials(self):
        with self.context():
            with self.assertRaisesRegex(ClientError, "session_cache_busy"):
                with self.context(lock_timeout_s=0.03):
                    pass
        self.assertEqual(len(self.exchanges()), 1)

    def test_reused_revoked_context_never_writes_without_acquiring_lock(self):
        context = self.context(lock_timeout_s=0.03)
        with context:
            pass
        self.server.reject_cookie = True
        with self.assertRaisesRegex(ClientError, "session_revoked"):
            with context:
                pass
        fd = os.open(str(self.cache) + ".lock", os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.cache.write_text("another operator's in-progress cache")
            before = self.cache.read_bytes()
            with self.assertRaisesRegex(ClientError, "session_cache_busy"):
                with context:
                    pass
            self.assertEqual(self.cache.read_bytes(), before)
            self.assertEqual(len(self.exchanges()), 1)
        finally:
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
