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

    def test_host_command_installs_exact_real_environment(self):
        from codex_service.profile import host_command
        command = host_command(Path("/opt/example/native"),
                               {"PATH": "/usr/bin:/bin", "HOME": "/home/example"})
        self.assertEqual(command, ["/usr/bin/env", "-i", "HOME=/home/example", "PATH=/usr/bin:/bin",
                                   "/opt/example/native", "app-server", "--listen", "stdio://"])
        for bad in ({"PATH": "/usr/bin"}, {"HOME": "/h", "PATH": "/p", "A=B": "x"}):
            with self.assertRaises(Exception):
                host_command(Path("/opt/example/native"), bad)


if __name__ == "__main__":
    unittest.main()
