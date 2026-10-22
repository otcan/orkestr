"""Operator host full access: exact sandbox selection and host native command."""
import unittest
from pathlib import Path
from protocol import Channel, PROTOCOL, Refused
from test_protocol import IDENTITY, request


def setup(full):
    channel = Channel(Path("/synthetic/workspace"), host_full_access=full)
    channel.client({"id": 1, "method": "OpenOwnedSession",
                    "params": {"protocol": PROTOCOL, "identity": dict(IDENTITY)}})
    request(channel, {"id": 1, "method": "initialize", "params": {
        "clientInfo": {"name": "synthetic", "title": "Synthetic", "version": "1"},
        "capabilities": {"experimentalApi": False}}})
    channel.provider({"id": 1, "result": {"userAgent": "synthetic", "platformFamily": "unix",
                                          "platformOs": "linux", "codexHome": "/synthetic"}})
    request(channel, {"method": "initialized"}, outer=3)
    request(channel, {"id": 2, "method": "account/read", "params": {"refreshToken": False}}, outer=4)
    channel.provider({"id": 2, "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
    return channel


def start(channel, sandbox):
    return request(channel, {"id": 3, "method": "thread/start", "params": {"cwd": channel.workspace,
        "approvalPolicy": "never", "sandbox": sandbox, "ephemeral": False, "modelProvider": "openai"}},
        outer=5)


def reply(channel, sandbox):
    return channel.provider({"id": 3, "result": {"thread": {"id": "synthetic-native",
        "cwd": channel.workspace, "ephemeral": False, "modelProvider": "openai"},
        "modelProvider": "openai", "cwd": channel.workspace, "approvalPolicy": "never",
        "sandbox": sandbox}})


class HostFullAccessTests(unittest.TestCase):
    def test_pinned_conversation_workspace_is_the_only_alternative_cwd(self):
        v1 = "/synthetic/v1/workspaces/thread"

        def pinned():
            channel = Channel(Path("/synthetic/workspace"), host_full_access=True,
                              conversation_workspaces=(v1,))
            channel.client({"id": 1, "method": "OpenOwnedSession",
                            "params": {"protocol": PROTOCOL, "identity": dict(IDENTITY)}})
            request(channel, {"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "synthetic", "title": "Synthetic", "version": "1"},
                "capabilities": {"experimentalApi": False}}})
            channel.provider({"id": 1, "result": {"userAgent": "synthetic", "platformFamily": "unix",
                                                  "platformOs": "linux", "codexHome": "/synthetic"}})
            request(channel, {"method": "initialized"}, outer=3)
            request(channel, {"id": 2, "method": "account/read", "params": {"refreshToken": False}}, outer=4)
            channel.provider({"id": 2, "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
            return channel

        def begin(channel, cwd):
            return request(channel, {"id": 3, "method": "thread/start", "params": {"cwd": cwd,
                "approvalPolicy": "never", "sandbox": "danger-full-access", "ephemeral": False,
                "modelProvider": "openai"}}, outer=5)

        channel = pinned()
        begin(channel, v1)
        self.assertEqual(channel.workspace, v1)
        result = reply(channel, {"type": "dangerFullAccess"})
        self.assertEqual(result["result"]["frame"]["result"]["cwd"], v1)
        # The instance workspace stays valid; any other directory is refused.
        channel = pinned()
        begin(channel, "/synthetic/workspace")
        reply(channel, {"type": "dangerFullAccess"})
        channel = pinned()
        with self.assertRaises(Refused):
            begin(channel, "/synthetic/elsewhere")
        # A provider reply naming another directory is refused.
        channel = pinned()
        begin(channel, v1)
        with self.assertRaises(Refused):
            channel.provider({"id": 3, "result": {"thread": {"id": "synthetic-native",
                "cwd": "/synthetic/workspace", "ephemeral": False, "modelProvider": "openai"},
                "modelProvider": "openai", "cwd": "/synthetic/workspace", "approvalPolicy": "never",
                "sandbox": {"type": "dangerFullAccess"}}})
        # Never without host full access.
        with self.assertRaises(Refused):
            Channel(Path("/synthetic/workspace"), conversation_workspaces=(v1,))

    def test_full_access_requires_and_reports_danger_full_access_only(self):
        channel = setup(True)
        with self.assertRaises(Refused):
            start(channel, "read-only")
        channel = setup(True)
        start(channel, "danger-full-access")
        with self.assertRaises(Refused):
            reply(channel, {"type": "readOnly", "networkAccess": False})
        channel = setup(True)
        start(channel, "danger-full-access")
        result = reply(channel, {"type": "dangerFullAccess"})
        self.assertEqual(result["result"]["frame"]["result"]["sandbox"], {"type": "dangerFullAccess"})

    def test_default_channel_still_refuses_full_access(self):
        channel = setup(False)
        with self.assertRaises(Refused):
            start(channel, "danger-full-access")
        channel = setup(False)
        start(channel, "read-only")
        with self.assertRaises(Refused):
            reply(channel, {"type": "dangerFullAccess"})

    def test_host_sub_agent_thread_events_are_dropped_not_fatal(self):
        for full, sandbox, reply_sandbox in ((True, "danger-full-access", {"type": "dangerFullAccess"}),
                                             (False, "read-only", {"type": "readOnly", "networkAccess": False})):
            channel = setup(full)
            start(channel, sandbox)
            reply(channel, reply_sandbox)
            sub = {"method": "turn/started", "params": {"threadId": "synthetic-sub-agent",
                   "turn": {"id": "sub-turn", "status": "inProgress"}}}
            if full:
                self.assertIsNone(channel.provider(sub))
                self.assertIsNone(channel.provider({"method": "item/agentMessage/delta", "params": {
                    "threadId": "synthetic-sub-agent", "turnId": "sub-turn", "delta": "x"}}))
            else:
                with self.assertRaises(Refused):
                    channel.provider(sub)

    def test_host_natives_accept_large_command_output_items(self):
        import types
        from codex_service.profile import HOST_PROVIDER_FRAME
        from protocol import MAX_FRAME
        from transport import Pump
        channel = setup(True)
        start(channel, "danger-full-access")
        reply(channel, {"type": "dangerFullAccess"})
        item = {"method": "item/completed", "params": {"threadId": "synthetic-native", "turnId": "t",
                "item": {"type": "commandExecution", "id": "exec-1", "aggregatedOutput": "x" * 200000}}}
        raw = __import__("json").dumps(item).encode()
        self.assertGreater(len(raw), MAX_FRAME)
        host = Pump(types.SimpleNamespace(max_provider_frame=HOST_PROVIDER_FRAME), channel, incoming=10**6, outgoing=10**6 + 1)
        self.assertEqual(host.limit(0), HOST_PROVIDER_FRAME)
        self.assertEqual(host.limit(10**6), MAX_FRAME)  # parent input keeps the bound
        host.line(0, raw)  # parsed and dropped: tool items are never forwarded
        self.assertEqual(len(host.queues[10**6 + 1]), 0)
        default = Pump(types.SimpleNamespace(), channel, incoming=10**6, outgoing=10**6 + 1)
        self.assertEqual(default.limit(0), MAX_FRAME)

    def test_host_command_installs_exact_real_environment(self):
        from codex_service.profile import host_command
        command = host_command(Path("/opt/example/native"),
                               {"PATH": "/usr/bin:/bin", "HOME": "/home/example"})
        self.assertEqual(command, ["/usr/bin/env", "-i", "HOME=/home/example", "PATH=/usr/bin:/bin",
                                   "/opt/example/native", "app-server", "--listen", "stdio://"])
        for bad in ({"PATH": "/usr/bin"}, {"HOME": "/h", "PATH": "/p", "A=B": "x"}):
            with self.assertRaises(Exception):
                host_command(Path("/opt/example/native"), bad)


NATIVE = "01a15956-93a3-7730-83a6-84853f05bb69"


class HostEnvironmentFileTests(unittest.TestCase):
    def test_private_env_file_reaches_the_native_but_never_its_argv(self):
        import os, subprocess, tempfile
        from codex_service.profile import host_command
        from codex_service.contract import Refused as ContractRefused
        with tempfile.TemporaryDirectory() as root:
            env = Path(root) / "tool.env"
            env.write_text("GOG_ACCOUNT='owner@example.invalid'\nGOG_CLIENT=\"synthetic client\"\n")
            env.chmod(0o600)
            native = Path(root) / "native"
            native.write_text("#!/bin/sh\nprintf '%s|%s|%s|%s' \"$GOG_ACCOUNT\" \"$GOG_CLIENT\" \"$HOME\" \"$*\"\n")
            native.chmod(0o700)
            command = host_command(native, {"HOME": "/home/example", "PATH": "/usr/bin:/bin"}, [str(env)])
            self.assertFalse(any("owner@example.invalid" in part or "synthetic client" in part for part in command))
            output = subprocess.run(command, capture_output=True, text=True, check=True).stdout
            self.assertEqual(output, "owner@example.invalid|synthetic client|/home/example|app-server --listen stdio://")
            for mode in (0o640, 0o604):
                env.chmod(mode)
                with self.assertRaises(ContractRefused):
                    host_command(native, {"HOME": "/home/example", "PATH": "/usr/bin:/bin"}, [str(env)])
            env.chmod(0o600)
            link = Path(root) / "link.env"
            link.symlink_to(env)
            with self.assertRaises(ContractRefused):
                host_command(native, {"HOME": "/home/example", "PATH": "/usr/bin:/bin"}, [str(link)])


class HostResumeTests(unittest.TestCase):
    """A thread the sandboxed provider created in a role's private state must
    resume under the host CODEX_HOME (Codex: `no rollout found` otherwise)."""

    def setUp(self):
        import tempfile
        temp = tempfile.TemporaryDirectory(prefix="synthetic-host-resume-")
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name) / "native-state"
        self.home = Path(temp.name) / "home/.codex"
        self.home.mkdir(parents=True)

    def rollout(self, root, native=NATIVE, day="2026/10/20", text=b'{"synthetic":1}\n'):
        path = root / "sessions" / day / f"rollout-2026-10-20T12-43-28-{native}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text)
        return path

    def test_private_rollout_is_imported_once_and_never_overwritten(self):
        from codex_service.profile import import_rollout
        source = self.rollout(self.state)
        self.assertEqual(import_rollout(self.state, self.home, NATIVE), "imported")
        target = self.home / source.relative_to(self.state)
        self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(target.parent.glob(".*")), [])  # No temporary left.
        source.write_bytes(b'{"changed":1}\n')
        self.assertEqual(import_rollout(self.state, self.home, NATIVE), "present")
        self.assertEqual(target.read_bytes(), b'{"synthetic":1}\n')

    def test_existing_host_thread_and_unknown_thread_are_left_alone(self):
        from codex_service.profile import import_rollout
        self.rollout(self.home, day="2026/10/19", text=b"host\n")
        self.rollout(self.state)
        self.assertEqual(import_rollout(self.state, self.home, NATIVE), "present")
        self.assertEqual(len(list((self.home / "sessions").glob("*/*/*/*.jsonl"))), 1)
        other = "01a15956-0000-7000-8000-000000000000"
        self.assertEqual(import_rollout(self.state, self.home, other), "absent")

    def test_refuses_unsafe_identity_layout_and_links(self):
        from codex_service.profile import import_rollout
        for bad in ("*", "../x", NATIVE.upper(), NATIVE + "/x", ""):
            with self.assertRaises(Exception):
                import_rollout(self.state, self.home, bad)
        self.rollout(self.state)
        self.rollout(self.state, day="2026/10/21")
        with self.assertRaisesRegex(Exception, "rollout_ambiguous"):
            import_rollout(self.state, self.home, NATIVE)
        state = self.state.parent / "linked-state"
        outside = self.rollout(self.state.parent / "outside", day="2026/10/22")
        link = state / "sessions/2026/10/22" / outside.name
        link.parent.mkdir(parents=True)
        link.symlink_to(outside)
        with self.assertRaisesRegex(Exception, "rollout_source"):
            import_rollout(state, self.home, NATIVE)
        self.assertEqual(list((self.home).rglob("*.jsonl")), [])

    def test_codex_home_follows_the_host_environment(self):
        from codex_service.profile import host_codex_home
        self.assertEqual(host_codex_home({"HOME": "/home/example", "PATH": "/bin"}),
                         Path("/home/example/.codex"))
        self.assertEqual(host_codex_home({"HOME": "/h", "PATH": "/bin", "CODEX_HOME": "/srv/codex"}),
                         Path("/srv/codex"))
        with self.assertRaises(Exception):
            host_codex_home({"HOME": "/h", "PATH": "/bin", "CODEX_HOME": "relative"})


if __name__ == "__main__":
    unittest.main()
