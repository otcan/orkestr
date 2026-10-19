"""Synthetic launcher specification only; no installed Claude invocation."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from claude_connector import ClaudeConfiguration


class ClaudeLauncherTests(unittest.TestCase):
    def test_fresh_session_fixed_options_and_clean_environment(self):
        with tempfile.TemporaryDirectory(prefix="claude-launcher-synthetic-") as root:
            root = Path(root).resolve()
            executable = root / "synthetic-native"
            executable.write_text("synthetic fixture only")
            for name in ("account", "workspace", "home", "tmp"):
                (root / name).mkdir()
            config = ClaudeConfiguration(executable, root / "account", root / "workspace",
                                         root / "home", root / "tmp")
            first, second = config.new_session(), config.new_session()
            self.assertNotEqual(first.native, second.native)
            command = first.command()
            self.assertNotIn("--resume", command)
            self.assertNotIn("--continue", command)
            self.assertEqual(command[command.index("--tools") + 1], "")
            self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
            with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "synthetic-secret"}):
                self.assertEqual(set(first.environment()),
                    {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "CLAUDE_CONFIG_DIR"})
                self.assertNotIn("synthetic-secret", str(first.environment()))

    def test_alias_account_refused(self):
        with tempfile.TemporaryDirectory(prefix="claude-alias-synthetic-") as root:
            root = Path(root).resolve()
            executable = root / "native"
            executable.write_text("fixture")
            (root / "account").mkdir()
            (root / "alias").symlink_to(root / "account")
            with self.assertRaises(ValueError):
                ClaudeConfiguration(executable, root / "alias", root, root, root).new_session()

    def test_owned_native_stream_single_turn(self):
        import array
        import json
        import select
        import socket
        from claude_protocol import ClaudeChannel
        from protocol import PROTOCOL, encode
        from test_protocol import IDENTITY
        from transport import Pump
        with tempfile.TemporaryDirectory(prefix="claude-stream-synthetic-") as root:
            root = Path(root).resolve()
            executable = root / "native"
            executable.write_text('''#!/usr/bin/python3
import json,sys
session=sys.argv[sys.argv.index("--session-id")+1]
setup=json.loads(sys.stdin.readline())
assert setup["request"]=={"subtype":"initialize","hooks":None}
print(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":setup["request_id"],"response":{}}}),flush=True)
for line in sys.stdin:
 value=json.loads(line)
 assert value["session_id"]==session
 print(json.dumps({"type":"result","subtype":"success","is_error":False,"uuid":"55555555-5555-4555-8555-555555555555","user_message_uuid":value["uuid"],"session_id":session,"result":"synthetic"}),flush=True)
''')
            executable.chmod(0o700)
            session = ClaudeConfiguration(executable, root, root, root, root).new_session()
            channel = ClaudeChannel(session)
            channel.client({"id":1,"method":"OpenOwnedSession","params":{
                "protocol":PROTOCOL,"identity":dict(IDENTITY, provider="claude")}})
            parent, child = socket.socketpair()
            parent.settimeout(5)
            pump = Pump(session, channel, incoming=100, outgoing=101, handoff=child)
            writer = None
            try:
                pump.launch()
                _, ancillary, _, _ = parent.recvmsg(64, socket.CMSG_SPACE(4))
                descriptors = array.array("i"); descriptors.frombytes(ancillary[0][2])
                writer = descriptors[0]
                native_pid = pump.child.pid
                def observation():
                    ready, _, _ = select.select([pump.child.stdout], [], [], 5)
                    self.assertTrue(ready)
                    raw = os.read(pump.child.stdout.fileno(), 65536)
                    return channel.provider(json.loads(raw))
                setup={"type":"control_request","request_id":"setup:1","request":{"subtype":"initialize","hooks":None}}
                channel.client({"id":100,"method":"BrokerMetadata","params":{"owned_handle":channel.handle,"frame":setup}})
                os.write(writer,encode(setup))
                observation()
                for outer in (2,):
                    frame = {"type":"user","uuid":"33333333-3333-4333-8333-333333333333","session_id":str(session.native),
                             "parent_tool_use_id":None,"message":{"role":"user","content":"synthetic"}}
                    channel.client({"id":outer,"method":"CommitExecution","params":{
                        "owned_handle":channel.handle,"message_id":f"message:{outer}","frame":frame}})
                    os.write(writer, encode(frame))  # synthetic parent; no Core claim
                    self.assertEqual(observation()["params"]["request_id"], outer)
                    self.assertEqual(pump.child.pid, native_pid)
                os.close(writer); writer = None
                self.assertEqual(pump.child.wait(timeout=5), 0)
            finally:
                if writer is not None:
                    os.close(writer)
                parent.close(); child.close(); pump.selector.close()
                if pump.child is not None:
                    if pump.child.poll() is None:
                        pump.child.kill()
                    pump.child.wait(timeout=5)
                    pump.child.stdout.close()

    def test_trusted_selected_account_callback_has_closed_environment(self):
        with tempfile.TemporaryDirectory(prefix="claude-selected-synthetic-") as root:
            root = Path(root).resolve()
            executable = root / "native"
            executable.write_text("fixture")
            config = ClaudeConfiguration(executable, root, root, root, root)
            selected = config.new_session(lambda: {"CLAUDE_CODE_OAUTH_TOKEN":"synthetic-only"})
            self.assertEqual(selected.environment()["CLAUDE_CODE_OAUTH_TOKEN"], "synthetic-only")
            for invalid in ({"ANTHROPIC_API_KEY":"synthetic"}, {"PATH":"foreign"}, {}):
                with self.assertRaises(ValueError):
                    config.new_session(lambda: invalid).environment()
