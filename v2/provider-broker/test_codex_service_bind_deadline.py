"""One caller deadline; synthetic metadata and owned Python children only."""
import json
import io
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from codex_bounded.trust import exists, process
from codex_service import channel
from codex_service.channel import ServerPeer
from codex_service.contract import canonical, decode, Refused
from codex_service.ledger import Ledger
from codex_service.manager import Manager
from codex_service.ownership import Children
from test_codex_service_bind_fixture import exchange


def uid():
    return str(uuid.uuid4())


def state(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]


class ContractTests(unittest.TestCase):
    def request(self):
        return {"version": 1, "operation": "bind_child", "request_id": "synthetic-bind",
                "owner_id": uid(), "conversation_id": uid(), "window_id": uid(),
                "generation": 1, "broker_pid": 123, "broker_start": 456,
                "bind_deadline_ms": 1800000005000}

    def test_closed_required_bind_deadline_type_and_operation(self):
        good = self.request()
        self.assertEqual(decode(canonical(good)), good)
        missing = {key: value for key, value in good.items() if key != "bind_deadline_ms"}
        bad = [missing, {**good, "extra": 0}]
        bad += [{**good, "bind_deadline_ms": value}
                for value in (None, True, "1800000005000", 1.5, 0, -1, 2**53)]
        bad += [{key: value for key, value in {**good, "operation": "status"}.items()
                 if key not in ("window_id", "generation", "broker_pid", "broker_start")}]
        for request in bad:
            with self.subTest(request=request), self.assertRaises(Refused):
                decode(canonical(request))
        for number in (b"NaN", b"Infinity", b"-Infinity", b"1e999"):
            raw = canonical(good).replace(b"1800000005000", number)
            with self.subTest(number=number), self.assertRaises(Refused):
                decode(raw)

    def test_caller_connection_and_window_caps_share_one_deadline(self):
        with patch("codex_service.channel.time.monotonic", return_value=10), \
                patch("codex_service.channel.time.time_ns", return_value=1800000000000000000):
            self.assertEqual(channel.bind_deadline(1800000005000, 10, 100), 15)
            # Receive consumed three seconds; a new field cannot renew that time.
            self.assertEqual(channel.bind_deadline(1800000005000, 7, 100), 12)
            self.assertEqual(channel.bind_deadline(1800000005000, 10, 10.2), 10.2)
            for value in (None, True, "1800000005000", float("nan"), float("inf"),
                          0, 1800000000000, 1799999999999, 1800000005001, 2**53):
                with self.subTest(value=value), self.assertRaises(Refused):
                    channel.bind_deadline(value, 10, 100)
            for accepted, work in ((5, 100), (10, 10), (10, 9)):
                with self.assertRaises(Refused):
                    channel.bind_deadline(1800000005000, accepted, work)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-bind-budget-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "codex_service").mkdir()
        self.entry = self.root / "codex_service/entry.py"
        self.marker = self.root / "continued"
        self.package = SimpleNamespace(root=self.root, uid=os.getuid(),
                                       verify_inventory=lambda: None)
        self.owner, self.conversation, self.window = uid(), uid(), uid()
        self.ledger = Ledger(self.root / "ledger.sqlite3", self.owner, self.conversation)
        self.addCleanup(self.ledger.close)
        opened = time.time_ns() // 1000000
        self.ledger.admit({"version": 1, "operation": "admit", "request_id": uid(),
            "owner_id": self.owner, "conversation_id": self.conversation,
            "window_id": self.window, "generation": 1, "expected_generation": 0,
            "predecessor_window_id": None, "input_message_id": uid(),
            "input_event_id": uid(), "input_request_key": uid(), "opened_at_ms": opened,
            "work_deadline_ms": opened + 870000, "expires_at_ms": opened + 900000})
        self.owned = []
        self.managers = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        # Preserve original child pidfds until the exact synthetic server has
        # run its finally/waiter and reaped its broker, including failed tests.
        for child in self.owned:
            if child.poll() is None:
                if child.stdin is None and child.stdout is not None:
                    child.terminate()
                else:
                    child.kill()
            try:
                child.wait(3)
            except subprocess.TimeoutExpired:
                for manager in self.managers:
                    manager.children.cleanup()
                child.kill()
                child.wait(3)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
            self.assertIsNone(process(child.pid), "owned synthetic child not reaped")
        ownership = self.root / "owned-broker.json"
        if ownership.exists():
            self.assertFalse(exists(json.loads(ownership.read_text())), "original broker not reaped")
        for manager in self.managers:
            manager.children.close()
        self.owned.clear()
        self.managers.clear()

    def write_entry(self, delay):
        self.entry.write_text("import os,signal,time\nfrom pathlib import Path\n"
            f"time.sleep({delay!r})\nos.kill(os.getpid(),signal.SIGSTOP)\n"
            f"Path({str(self.marker)!r}).write_text('continued')\n")

    def spawn(self, delay=0, extra=()):
        self.write_entry(delay)
        child = subprocess.Popen([str(Path("/usr/bin/python3").resolve()), "-I", "-S", "-B",
            str(self.entry), "broker", "open-owned-session", "--protocol",
            "orkestr-v2-provider-broker-v1", *extra], env={"PATH": "/usr/bin:/bin"},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.owned.append(child)
        return child, process(child.pid)

    def manager(self, identity):
        manager = Manager.__new__(Manager)
        manager.package, manager.ledger = self.package, self.ledger
        manager.identity = identity
        manager.failed = manager.closed = False
        manager.guard = threading.RLock()
        # One synthetic admitted window with its own original child set.
        window = SimpleNamespace(window=self.window, generation=1, egress_closed=False,
                                 children=Children(self.package, identity))
        window.close_egress = lambda: setattr(window, "egress_closed", True)
        manager.windows = {self.window: window}
        manager.children = window.children  # Test alias for the window's custody.
        self.managers.append(manager)
        manager.egress = SimpleNamespace(failed=False, close=lambda: None)
        return manager

    def request(self, identity, milliseconds=4000):
        return {"version": 1, "operation": "bind_child", "request_id": uid(),
                "owner_id": self.owner, "conversation_id": self.conversation,
                "window_id": self.window, "generation": 1,
                "broker_pid": identity["pid"], "broker_start": identity["start"],
                "bind_deadline_ms": time.time_ns() // 1000000 + milliseconds}

    def test_delayed_prologue_decoded_dispatch_same_baseline_fixture(self):
        # The identical decoded request reaches old dispatch (which ignores the
        # new deadline field), proving the original 0.8s failure independently
        # from the intentionally changed wire schema.
        child, identity = self.spawn(1.2)
        manager = self.manager(process(os.getpid()))
        started = time.monotonic()
        answer = manager.dispatch(self.request(identity))
        self.assertTrue(answer["ok"] and answer["fresh_child"])
        child.wait(3)
        self.assertGreater(time.monotonic() - started, 1.1)
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(self.marker.read_text(), "continued")
        self.assertTrue(manager.children.proven_gone())
        self.assertFalse(manager.children.forced)
        self.assertEqual(self.ledger.status()["attempts"], 0)

    def test_invalid_package_never_waits_for_or_continues_a_broker(self):
        child, identity = self.spawn(2)
        manager = self.manager(process(os.getpid()))
        def invalid():
            raise Refused("unexpected_package_file")
        self.package.verify_inventory = invalid
        with patch.object(manager.children, "bind") as bind, \
                patch("codex_service.manager.sys.stderr", io.StringIO()) as output:
            started = time.monotonic()
            with self.assertRaisesRegex(Refused, "^broker_binding$"):
                manager.dispatch(self.request(identity))
            self.assertLess(time.monotonic() - started, 1)
            bind.assert_not_called()
            self.assertEqual(output.getvalue(),
                             "ALERT orkestr-v2-manager package_inventory_invalid\n")
        self.assertFalse(self.marker.exists())

    def test_expired_or_invalid_internal_deadline_never_records_or_continues(self):
        child, identity = self.spawn()
        manager = self.manager(process(os.getpid()))
        for deadline in (None, True, "5", float("nan"), float("inf"),
                         time.monotonic() - 1, time.monotonic() + 6):
            with self.subTest(deadline=deadline), self.assertRaises(Refused):
                manager.children.bind(child.pid, identity["start"], deadline)
            self.assertFalse(manager.children.records)
            self.assertFalse(manager.children.brokers)
        self.assertFalse(self.marker.exists())

    def test_expiry_during_final_source_validation_never_continues(self):
        child, identity = self.spawn()
        manager = self.manager(process(os.getpid()))
        deadline = time.monotonic() + 2
        while state(child.pid) != "T":
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        original = Path.read_bytes
        def delayed(path):
            raw = original(path)
            if path == Path(f"/proc/{child.pid}/cmdline"):
                time.sleep(.15)
            return raw
        with patch.object(Path, "read_bytes", delayed), self.assertRaisesRegex(Refused, "broker_pause_deadline"):
            manager.children.bind(child.pid, identity["start"], time.monotonic() + .1)
        self.assertFalse(manager.children.brokers)
        self.assertEqual(state(child.pid), "T")
        self.assertFalse(self.marker.exists())

    def test_wrong_parent_uid_start_and_argv_still_refuse(self):
        child, identity = self.spawn(extra=("foreign",))
        for field, value in (("pid", os.getpid() + 100000), ("uid", os.getuid() + 1)):
            owner = process(os.getpid())
            manager = self.manager(owner)
            if field == "pid":
                manager.children.server["pid"] = value
            else:
                manager.children.package = SimpleNamespace(root=self.root, uid=value)
            with self.assertRaisesRegex(Refused, "broker_owner"):
                manager.children.bind(child.pid, identity["start"], time.monotonic() + 2)
        manager = self.manager(process(os.getpid()))
        with self.assertRaisesRegex(Refused, "broker_owner"):
            manager.children.bind(child.pid, identity["start"] + 1, time.monotonic() + 2)
        with self.assertRaisesRegex(Refused, "broker_source"):
            manager.children.bind(child.pid, identity["start"], time.monotonic() + 2)
        self.assertFalse(manager.children.brokers)
        self.assertFalse(self.marker.exists())

    def wire(self, *, frame_delay=0, pause_delay=1.2, budget_ms=4000, reply_delay=0,
             fail_before_bind=False):
        self.write_entry(pause_delay)
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        endpoint = self.root / "control.sock"
        listener.bind(str(endpoint))
        listener.listen(1)
        listener.settimeout(4)
        request = self.request({"pid": 2, "start": 1}, budget_ms)
        server = exchange(endpoint, self.entry, request, frame_delay)
        self.owned.append(server)
        manager = self.manager(process(server.pid))
        manager.child = server
        manager.peer = ServerPeer(manager.identity, Path("/usr/bin/python3").resolve())
        manager.control = SimpleNamespace(socket=listener)
        if fail_before_bind:
            deadline = time.monotonic() + 2
            ownership = self.root / "owned-broker.json"
            while not ownership.exists():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.005)
            identity = json.loads(ownership.read_text())
            while state(identity["pid"]) != "T":
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.005)
            raise RuntimeError("injected test failure before child registration")
        import codex_service.manager as module
        real_respond = module.respond
        def late_respond(connection, answer, deadline):
            time.sleep(reply_delay)
            return real_respond(connection, answer, deadline)
        started = time.monotonic()
        with patch.object(module, "respond", late_respond):
            manager.once()
        stdout, stderr = server.communicate(timeout=10)
        self.assertEqual((server.returncode, stderr), (0, ""))
        result = json.loads(stdout)
        self.assertTrue(result["reaped"])
        self.assertFalse(exists(result["broker"]))
        self.assertIsNone(process(server.pid))
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(self.ledger.status()["attempts"], 0)
        self.assertEqual(self.ledger.status()["reserved_bytes"], 0)
        return manager, result

    def test_manager_once_real_peer_delayed_pause_and_original_reap(self):
        manager, result = self.wire()
        self.assertTrue(result["answer"]["ok"] and result["answer"]["fresh_child"])
        self.assertEqual(self.marker.read_text(), "continued")
        self.assertTrue(manager.children.proven_gone())
        self.assertFalse(manager.children.forced)

    def test_fixture_failure_before_registration_reaps_stopped_grandchild(self):
        with self.assertRaisesRegex(RuntimeError, "injected test failure"):
            self.wire(pause_delay=0, fail_before_bind=True)
        identity = json.loads((self.root / "owned-broker.json").read_text())
        self.assertEqual(state(identity["pid"]), "T")
        self.assertFalse(self.managers[0].children.records)
        self.cleanup()
        self.assertFalse(exists(identity))
        self.assertFalse(self.marker.exists())

    def test_receive_plus_pause_cannot_renew_original_caller_budget(self):
        manager, result = self.wire(frame_delay=.4, pause_delay=.55, budget_ms=800)
        if result["answer"] is not None:
            self.assertFalse(result["answer"]["ok"])
            self.assertEqual(result["answer"]["code"], "control_refused")
        self.assertFalse(self.marker.exists())
        self.assertFalse(manager.children.brokers)
        self.assertEqual(self.ledger.status()["state"], "reconciliation")
        with self.assertRaises(Refused):
            manager.children.proven_gone()

    def test_frame_still_has_one_second_bound_despite_long_bind_budget(self):
        manager, result = self.wire(frame_delay=1.2, pause_delay=.1)
        self.assertIsNone(result["answer"])
        self.assertFalse(manager.children.brokers)
        self.assertFalse(self.marker.exists())

    def test_reply_after_bound_is_not_success_or_retry_or_retirement(self):
        manager, result = self.wire(pause_delay=.1, budget_ms=500, reply_delay=.6)
        self.assertIsNone(result["answer"])
        self.assertTrue(manager.children.proven_gone())
        self.assertEqual(self.ledger.status()["state"], "active")
        self.assertEqual(self.marker.read_text(), "continued")
        # The server cannot infer failure-before-effect from lost ACK. Its
        # ordinary uncertainty report remains sticky; no implicit retry/retire.
        manager.dispatch({"operation": "uncertain", "owner_id": self.owner,
            "conversation_id": self.conversation, "window_id": self.window,
            "generation": 1, "reason": "runtime_refused"})
        self.assertEqual(self.ledger.status()["state"], "reconciliation")


if __name__ == "__main__":
    unittest.main()
