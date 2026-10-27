"""Owned synthetic children only; no native executable, account or endpoint."""
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import time
import types
import unittest
from unittest.mock import patch

from protocol import Channel, Failure, PROTOCOL, Refused, decode
from transport import Pump, failure_exit
from reaping import reap_owned
import test_continuation


def code(failure, state):
    return 80 + (int(failure) - 1) * 6 + state


class ExitDiagnostics(unittest.TestCase):
    def child(self, source):
        child = subprocess.Popen([sys.executable, "-I", "-S", "-B", "-c", source],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True)
        self.addCleanup(self.close_child, child)
        return child

    @staticmethod
    def close_child(child):
        if child.returncode is None:
            child.kill()
            child.wait(timeout=2)
        if child.stdout is not None:
            child.stdout.close()
        with contextlib.suppress(FileNotFoundError):
            # An unreaped zombie remains an obligation, not successful cleanup.
            with open(f"/proc/{child.pid}/stat"):
                raise AssertionError("owned original remains")

    def exited(self, child):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            value = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if value is not None:
                return value
            time.sleep(.005)
        self.fail("owned synthetic child did not exit")

    def test_actual_exit_observation_is_before_reap(self):
        for status, state in ((0, 2), (7, 3)):
            with self.subTest(status=status):
                child = self.child(f"raise SystemExit({status})")
                self.exited(child)
                result = failure_exit(Refused("unused", Failure.PROVIDER_EOF), child)
                self.assertEqual(result, code(Failure.PROVIDER_EOF, state))
                self.assertEqual(self.exited(child).si_status, status)
                self.assertIsNone(child.returncode)
                self.assertEqual(child.wait(timeout=2), status)

    def test_actual_live_and_signalled_original(self):
        child = self.child("import time; time.sleep(10)")
        error = Refused("unused", Failure.PROVIDER_EOF)
        self.assertEqual(failure_exit(error, child), code(Failure.PROVIDER_EOF, 1))
        child.send_signal(signal.SIGTERM)
        self.exited(child)
        self.assertEqual(failure_exit(error, child), code(Failure.PROVIDER_EOF, 4))
        self.assertEqual(child.wait(timeout=2), -signal.SIGTERM)

    def test_unknown_child_status_never_proves_absence(self):
        with patch("transport.os.waitid", side_effect=ChildProcessError):
            self.assertEqual(failure_exit(Refused("unused"), types.SimpleNamespace(pid=1)),
                             code(Failure.PROTOCOL, 5))

    def test_every_category_is_closed_and_cannot_claim_success_or_reap(self):
        self.assertEqual(str(Refused()), "")
        self.assertEqual(Refused().failure, Failure.PROTOCOL)
        results = set()
        statuses = [None,
            types.SimpleNamespace(si_code=os.CLD_EXITED, si_status=0),
            types.SimpleNamespace(si_code=os.CLD_EXITED, si_status=1),
            types.SimpleNamespace(si_code=os.CLD_KILLED, si_status=9),
            types.SimpleNamespace(si_code=999, si_status=999)]
        for failure in Failure:
            error = Refused("SYNTHETIC-CONTENT-CANARY", failure)
            results.add(failure_exit(error, None))
            for value in statuses:
                with patch("transport.os.waitid", return_value=value):
                    results.add(failure_exit(error, types.SimpleNamespace(pid=1)))
        self.assertEqual(results, set(range(80, 218)))
        self.assertFalse({0, 73} & results)
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(failure_exit(RuntimeError("SYNTHETIC-CONTENT-CANARY"), None),
                             code(Failure.INTERNAL, 0))
        self.assertEqual(out.getvalue() + err.getvalue(), "")

    def pump(self, child, channel, diagnostics=True):
        incoming, parent = os.pipe()
        outgoing, output = os.pipe()
        for fd in (incoming, parent, outgoing, output):
            self.addCleanup(os.close, fd)
        pump = Pump(None, channel, incoming=incoming, outgoing=output, diagnostics=diagnostics)
        pump.child = child
        os.set_blocking(child.stdout.fileno(), False)
        return pump

    def test_provider_eof_is_sampled_before_finally_signals_or_reaps(self):
        child = self.child("raise SystemExit(7)")
        self.exited(child)
        pump = self.pump(child, Channel("/synthetic/workspace"))
        def cleanup(original):
            self.assertIs(original, child)
            self.assertEqual(pump.failure_exit, code(Failure.PROVIDER_EOF, 3))
            self.assertEqual(self.exited(original).si_status, 7)
            return reap_owned(original)
        with patch("transport.reap_owned", side_effect=cleanup):
            with self.assertRaises(Refused):
                pump.run()
        self.assertTrue(pump.reaped)
        self.assertFalse(pump.parent_eof)

    def test_default_brokers_do_not_observe_diagnostics(self):
        child = self.child("raise SystemExit(7)")
        self.exited(child)
        pump = self.pump(child, Channel("/synthetic/workspace"), diagnostics=False)
        with patch("transport.failure_exit", side_effect=AssertionError("unexpected diagnostic")):
            with self.assertRaises(Refused):
                pump.run()
        self.assertEqual(pump.failure_exit, 2)
        self.assertTrue(pump.reaped)

    def test_actual_late_completion_still_refuses_and_reaps(self):
        channel = test_continuation.ContinuationTests().previous()
        frame = {"method": "turn/completed", "params": {"threadId": channel.native,
                 "turn": {"id": "old-turn", "status": "completed"},
                 "ignored": "SYNTHETIC-CONTENT-CANARY"}}
        child = self.child("import time; print(" + repr(json.dumps(frame)) +
                           ", flush=True); time.sleep(10)")
        pump = self.pump(child, channel)
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(Refused):
                pump.run()
        self.assertEqual(pump.failure_exit, code(Failure.LATE_TURN_COMPLETED, 1))
        self.assertTrue(pump.reaped)
        self.assertTrue(channel.terminal)
        self.assertEqual(out.getvalue() + err.getvalue(), "")

    def test_known_terminal_notices_and_unexpected_response_have_distinct_guards(self):
        for method, expected in (("turn/started", Failure.LATE_TURN_STARTED),
                                 ("turn/completed", Failure.LATE_TURN_COMPLETED),
                                 ("item/agentMessage/delta", Failure.LATE_AGENT_DELTA)):
            channel = test_continuation.ContinuationTests().previous()
            with self.assertRaises(Refused) as caught:
                channel.provider({"method": method, "params": {}})
            self.assertEqual(caught.exception.failure, expected)
            self.assertTrue(channel.terminal)
        channel = test_continuation.ContinuationTests().previous()
        self.assertIsNone(channel.provider({"method": "unknown-SYNTHETIC-CANARY", "params": {}}))
        with self.assertRaises(Refused) as caught:
            channel.provider({"id": 999, "result": {"text": "SYNTHETIC-CANARY"}})
        self.assertEqual(caught.exception.failure, Failure.UNEXPECTED_RESPONSE)
        self.assertIsNone(channel.pending)

    def test_decode_classification_retains_refusal(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'\xff', b'not json'):
            with self.subTest(raw=raw), self.assertRaises(Refused) as caught:
                decode(raw)
            self.assertEqual(caught.exception.failure, Failure.FRAME_DECODE)

    def service(self, *, resumed=False, failure=None, parent_eof=True, reaped=True, host=None):
        from codex_service import broker
        class SyntheticPump:
            def __init__(self, config, channel, **kwargs):
                self.diagnostics = kwargs["diagnostics"]
                self.failure_exit = failure
                self.parent_eof, self.reaped = parent_eof, reaped
                self.child = object()
            def run(self):
                if failure is not None:
                    raise Refused("SYNTHETIC-CANARY")
        endpoint = types.SimpleNamespace(family=broker.socket.AF_UNIX,
            type=broker.socket.SOCK_STREAM, getpeername=lambda: None)
        package = types.SimpleNamespace(root="/synthetic", uid=os.geteuid(),
            role_profiles={"deep": "/synthetic/profile.json"})
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(broker, "Package", return_value=package))
            config = types.SimpleNamespace(workspace="/synthetic/workspace")
            if host is not None:
                config.host_full_access, config.host_resume = True, host
            configuration = stack.enter_context(patch.object(broker, "Configuration", return_value=config))
            stack.enter_context(patch.object(broker, "modules", return_value=(
                Channel, PROTOCOL, Refused, lambda: None, 73, object)))
            stack.enter_context(patch.object(broker, "pump_type", return_value=SyntheticPump))
            stack.enter_context(patch.object(broker.socket, "socket", return_value=contextlib.nullcontext(endpoint)))
            stack.enter_context(patch.object(broker.ctypes, "CDLL", return_value=types.SimpleNamespace(prctl=lambda *a: 0)))
            stack.enter_context(patch.object(broker.signal, "signal"))
            paused = stack.enter_context(patch.object(broker.os, "kill"))
            stack.enter_context(patch.object(broker.sys, "argv", ["broker", "resume-owned-session" if resumed
                else "open-owned-session", "--protocol", PROTOCOL]))
            receive = stack.enter_context(patch("codex_bootstrap.receive", return_value="synthetic-native"))
            output = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            result = broker.main("/synthetic")
            configuration.assert_called_once_with(package, "deep")
            paused.assert_called_once_with(os.getpid(), signal.SIGSTOP)
            self.assertEqual(receive.call_count, int(resumed))
            self.assertNotIn("SYNTHETIC-CANARY", output.getvalue())
            return result

    def test_host_resume_imports_only_the_received_native_after_bind(self):
        for resumed in (False, True):
            imported = []
            self.assertEqual(self.service(resumed=resumed, host=imported.append), 73)
            self.assertEqual(imported, ["synthetic-native"] if resumed else [])
        def refused(_native):
            raise Refused("SYNTHETIC-CANARY")
        self.assertEqual(self.service(resumed=True, host=refused), 2)

    def test_service_fresh_resume_codes_and_exclusive_reap_exit(self):
        for resumed in (False, True):
            self.assertEqual(self.service(resumed=resumed), 73)
            self.assertEqual(self.service(resumed=resumed, failure=140), 140)
            for invalid in (0, 73, -1, 218, "provider-controlled", True):
                self.assertEqual(self.service(resumed=resumed, failure=invalid), 2)
            self.assertNotEqual(self.service(resumed=resumed, parent_eof=False), 73)
            self.assertNotEqual(self.service(resumed=resumed, reaped=False), 73)

    def test_native_ended_and_reaped_maps_only_provider_eof(self):
        # PROVIDER_EOF (98..103) with the owned tree reaped to ECHILD and no
        # parent EOF: the idle native died on its own; 218 + native state.
        for resumed in (False, True):
            self.assertEqual(self.service(resumed=resumed, failure=102, parent_eof=False), 222)
            self.assertEqual(self.service(resumed=resumed, failure=98, parent_eof=False), 218)
            self.assertEqual(self.service(resumed=resumed, failure=102, parent_eof=False, reaped=False), 102)
            self.assertEqual(self.service(resumed=resumed, failure=102), 102)
            self.assertEqual(self.service(resumed=resumed, failure=140, parent_eof=False), 140)


if __name__ == "__main__":
    unittest.main()
