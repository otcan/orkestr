"""Operator host full access (YOLO) for owned Claude sessions; synthetic values only."""
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from claude_connector import ClaudeConfiguration
from claude_protocol import ClaudeChannel
from protocol import PROTOCOL, Refused
from test_protocol import IDENTITY

INPUT = "33333333-3333-4333-8333-333333333333"
ENVIRONMENT = {"HOME": "/home/example", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}


class FullAccessConfigurationTests(unittest.TestCase):
    def write(self, root, **extra):
        executable = root / "native"
        executable.write_text("synthetic fixture only")
        for name in ("account", "workspace", "home", "tmp"):
            (root / name).mkdir(exist_ok=True)
        value = {"executable": str(executable), "account": str(root / "account"),
                 "workspace": str(root / "workspace"), "home": str(root / "home"),
                 "temporary": str(root / "tmp"), **extra}
        path = root / "claude-private.json"
        path.write_text(json.dumps(value))
        return path

    def test_default_configuration_stays_contained_and_toolless(self):
        with tempfile.TemporaryDirectory(prefix="claude-full-access-") as root:
            session = ClaudeConfiguration.load(self.write(Path(root).resolve())).new_session()
            self.assertFalse(session.uncontained)
            self.assertEqual(session.max_provider_frame, 65536)
            self.assertNotIn("--dangerously-skip-permissions", session.command())
            self.assertEqual(session.command()[session.command().index("--tools") + 1], "")

    def test_opt_in_runs_on_host_with_skip_permissions_and_real_environment(self):
        with tempfile.TemporaryDirectory(prefix="claude-full-access-") as root:
            root = Path(root).resolve()
            config = ClaudeConfiguration.load(self.write(
                root, host_full_access={"environment": ENVIRONMENT}))
            session = config.new_session()
            command = session.command()
            self.assertTrue(session.uncontained)
            self.assertIn("--dangerously-skip-permissions", command)
            for restricted in ("--tools", "--restricted", "--safe-mode", "--permission-mode"):
                self.assertNotIn(restricted, command)
            self.assertEqual(command[-2:], ["--session-id", str(session.native)])
            environment = session.environment()
            self.assertEqual(environment["HOME"], "/home/example")
            self.assertEqual(environment["CLAUDE_CONFIG_DIR"], str(root / "account"))
            self.assertEqual(environment["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"], "1")
            self.assertGreater(session.max_provider_frame, 65536)

    def test_owner_model_and_effort_reach_native_environment_closed(self):
        from claude_connector import turn_preferences
        self.assertEqual(turn_preferences({}), {})
        self.assertEqual(turn_preferences({"ORKESTR_CLAUDE_MODEL": "claude-opus-5-5",
                                           "ORKESTR_CLAUDE_EFFORT": "low"}),
                         {"ANTHROPIC_MODEL": "claude-opus-5-5", "CLAUDE_CODE_EFFORT_LEVEL": "low"})
        for bad in ({"ORKESTR_CLAUDE_MODEL": "bad model"}, {"ORKESTR_CLAUDE_MODEL": "123"},
                    {"ORKESTR_CLAUDE_MODEL": ""}, {"ORKESTR_CLAUDE_EFFORT": "ultra"}):
            with self.assertRaises(ValueError):
                turn_preferences(bad)

    def test_environment_cannot_select_account_or_omit_home(self):
        for environment in ({"PATH": "/usr/bin"}, {"HOME": "relative", "PATH": "/usr/bin"},
                            dict(ENVIRONMENT, ANTHROPIC_API_KEY="synthetic"),
                            dict(ENVIRONMENT, CLAUDE_CODE_OAUTH_TOKEN="synthetic"),
                            dict(ENVIRONMENT, CLAUDE_CONFIG_DIR="/elsewhere"),
                            dict(ENVIRONMENT, **{"BAD=KEY": "x"})):
            with tempfile.TemporaryDirectory(prefix="claude-full-access-") as root:
                path = self.write(Path(root).resolve(), host_full_access={"environment": environment})
                with self.assertRaises(ValueError):
                    ClaudeConfiguration.load(path)
        with tempfile.TemporaryDirectory(prefix="claude-full-access-") as root:
            path = self.write(Path(root).resolve(),
                              host_full_access={"environment": ENVIRONMENT, "sandbox": "off"})
            with self.assertRaises(ValueError):
                ClaudeConfiguration.load(path)

    def test_pinned_conversation_workspace_is_the_only_alternative_cwd(self):
        from codex_service.claude_broker import conversation_workspace
        from codex_service.contract import Refused as BrokerRefused
        with tempfile.TemporaryDirectory(prefix="claude-full-access-") as root:
            root = Path(root).resolve()
            thread = root / "v1-thread"
            thread.mkdir()
            elsewhere = root / "elsewhere"
            elsewhere.mkdir()
            config = ClaudeConfiguration.load(self.write(
                root, host_full_access={"environment": ENVIRONMENT}))
            beta = {"host_full_access": {"environment": ENVIRONMENT},
                    "conversation_workspaces": {INPUT: str(thread)}}
            # The configured workspace stays valid and unchanged.
            self.assertIs(conversation_workspace(config, beta, root / "workspace"), config)
            self.assertIs(conversation_workspace(config, {}, root / "workspace"), config)
            selected = conversation_workspace(config, beta, thread)
            self.assertEqual(selected.workspace, thread)
            self.assertEqual(selected.account, config.account)
            session = selected.new_session()
            self.assertEqual(session.workspace, thread)
            self.assertTrue(session.uncontained)
            # Any other directory, or a pin without host full access, is refused.
            for cwd, table in ((elsewhere, beta), (thread, {}),
                               (thread, {"conversation_workspaces": {INPUT: str(thread)}})):
                with self.assertRaises(BrokerRefused):
                    conversation_workspace(config, table, cwd)
            contained = ClaudeConfiguration.load(self.write(root))
            with self.assertRaises(BrokerRefused):
                conversation_workspace(contained, beta, thread)
            # A pinned directory that no longer exists is refused.
            gone = root / "gone"
            with self.assertRaises((ValueError, OSError)):
                conversation_workspace(config, dict(beta, conversation_workspaces={INPUT: str(gone)}),
                                       gone)


def tool_turn(tools):
    native = "11111111-1111-4111-8111-111111111111"
    channel = ClaudeChannel(SimpleNamespace(native=native, uncontained=tools))
    _, reply = channel.client({"id": 1, "method": "OpenOwnedSession", "params": {
        "protocol": PROTOCOL, "identity": dict(IDENTITY, provider="claude")}})
    handle = reply["result"]["owned_handle"]
    channel.client({"id": 2, "method": "BrokerMetadata", "params": {"owned_handle": handle,
        "frame": {"type": "control_request", "request_id": "initialize:2",
                  "request": {"subtype": "initialize", "hooks": None}}}})
    channel.provider({"type": "control_response", "response": {"subtype": "success",
                      "request_id": "initialize:2", "response": {}}})
    channel.client({"id": 3, "method": "CommitExecution", "params": {"owned_handle": handle,
        "message_id": "message:1", "frame": {"type": "user", "uuid": INPUT, "session_id": native,
        "parent_tool_use_id": None, "message": {"role": "user", "content": "synthetic"}}}})
    channel.provider({"type": "system", "subtype": "init", "session_id": native})
    tool_use = {"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()),
                "parent_tool_use_id": None, "user_message_uuid": INPUT, "wire_tool_inputs": {},
                "message": {"id": "msg_1", "role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "true"}}]}}
    result = {"type": "user", "session_id": native, "uuid": str(uuid.uuid4()),
              "parent_tool_use_id": None, "tool_use_result": {"stdout": "synthetic private output"},
              "message": {"role": "user", "content": [{"type": "tool_result",
                          "tool_use_id": "toolu_1", "content": "synthetic private output"}]}}
    answer = {"type": "assistant", "session_id": native, "uuid": str(uuid.uuid4()),
              "parent_tool_use_id": None, "message": {"id": "msg_2", "role": "assistant",
              "content": [{"type": "text", "text": "done"}]}}
    return channel, native, [tool_use, result, answer]


class FullAccessCodecTests(unittest.TestCase):
    def test_tool_traffic_drains_and_only_text_is_forwarded(self):
        channel, native, frames = tool_turn(True)
        outputs = [channel.provider(frame) for frame in frames]
        self.assertEqual(outputs[:2], [None, None])
        self.assertEqual(outputs[2]["params"]["frame"]["message"]["content"],
                         [{"type": "text", "text": "done"}])
        self.assertEqual(outputs[2]["params"]["frame"]["user_message_uuid"], INPUT)
        self.assertNotIn("synthetic private output", str(outputs))
        subagent = dict(frames[2], parent_tool_use_id="toolu_1", uuid=str(uuid.uuid4()))
        self.assertIsNone(channel.provider(subagent))

    def test_tool_progress_and_keep_alive_drain_during_long_tools(self):
        channel, native, frames = tool_turn(True)
        channel.provider(frames[0])
        progress = {"type": "tool_progress", "tool_use_id": "toolu_1-heartbeat-0", "tool_name": "Bash",
                    "parent_tool_use_id": "toolu_1", "elapsed_time_seconds": 30,
                    "session_id": native, "uuid": str(uuid.uuid4())}
        for _ in range(64):
            self.assertIsNone(channel.provider(dict(progress, uuid=str(uuid.uuid4()))))
            self.assertIsNone(channel.provider({"type": "keep_alive"}))
        self.assertEqual(channel.provider(frames[2])["params"]["frame"]["message"]["content"],
                         [{"type": "text", "text": "done"}])
        with self.assertRaises(Refused):
            channel, native, frames = tool_turn(True)
            channel.provider(dict(progress, session_id="foreign"))

    def test_contained_session_still_refuses_tool_traffic(self):
        channel, _, frames = tool_turn(False)
        with self.assertRaises(Refused):
            channel.provider(frames[0])

    def test_tool_result_before_this_turn_joined_is_refused(self):
        channel, _, frames = tool_turn(True)
        with self.assertRaises(Refused):
            channel.provider(frames[1])

    def test_interrupt_during_tool_reports_aborted_tools(self):
        channel, native, frames = tool_turn(True)
        channel.provider(frames[0])
        channel.client({"id": 4, "method": "CancelExecution", "params": {
            "owned_handle": channel.handle, "frame": {"type": "control_request",
            "request_id": "interrupt:4", "request": {"subtype": "interrupt",
            "cancel_queued": False, "for_user_message_uuids": [INPUT]}}}})
        self.assertIsNone(channel.provider(frames[1]))
        terminal = channel.provider({"type": "result", "uuid": str(uuid.uuid4()),
            "session_id": native, "user_message_uuid": INPUT, "subtype": "error_during_execution",
            "is_error": True, "terminal_reason": "aborted_tools"})
        self.assertEqual(terminal["params"]["frame"]["terminal_reason"], "aborted_streaming")
        self.assertTrue(channel.terminal)


class ProviderFrameBoundTests(unittest.TestCase):
    def test_only_provider_source_uses_larger_opt_in_bound(self):
        from transport import Pump
        from protocol import MAX_FRAME
        pump = Pump(SimpleNamespace(max_provider_frame=4 * 1024 * 1024), None,
                    incoming=100, outgoing=101)
        try:
            self.assertEqual(pump.limit(100), MAX_FRAME)
            self.assertEqual(pump.limit(7), 4 * 1024 * 1024)
        finally:
            pump.selector.close()
        with self.assertRaises(Refused):
            Pump(SimpleNamespace(max_provider_frame=1024), None)


class OwnedLifetimeTests(unittest.TestCase):
    def test_contained_native_has_usable_device_nodes(self):
        import subprocess, sys
        from transport import contained_command
        probe = ("open('/dev/null','wb').write(b'x');"
                 "assert len(open('/dev/urandom','rb').read(8))==8")
        result = subprocess.run(contained_command([sys.executable, "-c", probe]),
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_uncontained_cleanup_reaps_escaped_descendants(self):
        import subprocess, sys
        source = """import subprocess,sys,time
from reaping import become_subreaper
from transport import reap_uncontained
become_subreaper()
code = "import os,time\\nif os.fork()==0:\\n os.setsid()\\n if os.fork()==0: time.sleep(30)\\n time.sleep(30)\\ntime.sleep(30)"
child=subprocess.Popen([sys.executable,'-c',code],process_group=0)
time.sleep(.3)
assert reap_uncontained(child,timeout=3) is True
"""
        result = subprocess.run([sys.executable, "-c", source], cwd=Path(__file__).parent,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
