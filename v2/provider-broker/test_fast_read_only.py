"""Fast is read-only on every instance: sandbox, side-effect tools and broker role.

Fast runs in parallel with Deep on the same input, so any Fast write or external
action would happen twice. These tests pin the broker-level enforcement that a
model cannot bypass from its prompt. Synthetic values only.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import types
import unittest
from claude_connector import (ClaudeConfiguration, FAST_DISALLOWED_TOOLS, FAST_SETTINGS,
                              FAST_TOOLS)
from claude_protocol import ClaudeChannel
from protocol import FAST_SANDBOX, PROTOCOL, Channel, Refused
from test_protocol import IDENTITY, request

FAST = dict(IDENTITY, role="fast")
WORKSPACE = Path("/synthetic/workspace")
PINNED = "/synthetic/v1/workspaces/thread"
# Write or side-effect tool families that must never exist in a Fast session.
SIDE_EFFECT_FEATURES = ("apps", "plugins", "browser_use", "computer_use", "in_app_browser",
                        "multi_agent", "memories", "goals", "worktrees")
SIDE_EFFECT_CLAUDE_TOOLS = ("Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "Task")


def opened(identity, *, host=True, fast_only=False, workspaces=()):
    channel = Channel(WORKSPACE, host_full_access=host, conversation_workspaces=workspaces,
                      fast_only=fast_only)
    channel.client({"id": 1, "method": "OpenOwnedSession",
                    "params": {"protocol": PROTOCOL, "identity": dict(identity)}})
    request(channel, {"id": 1, "method": "initialize", "params": {
        "clientInfo": {"name": "synthetic", "title": "Synthetic", "version": "1"},
        "capabilities": {"experimentalApi": False}}})
    channel.provider({"id": 1, "result": {"userAgent": "synthetic", "platformFamily": "unix",
                                          "platformOs": "linux", "codexHome": "/synthetic"}})
    request(channel, {"method": "initialized"}, outer=3)
    request(channel, {"id": 2, "method": "account/read", "params": {"refreshToken": False}}, outer=4)
    channel.provider({"id": 2, "result": {"requiresOpenaiAuth": True, "account": {"type": "chatgpt"}}})
    return channel


def start(channel, sandbox, cwd=None):
    return request(channel, {"id": 3, "method": "thread/start", "params": {
        "cwd": cwd or channel.workspace, "approvalPolicy": "never", "sandbox": sandbox,
        "ephemeral": False, "modelProvider": "openai"}}, outer=5)


def reply(channel, sandbox):
    return channel.provider({"id": 3, "result": {"thread": {"id": "synthetic-native",
        "cwd": channel.workspace, "ephemeral": False, "modelProvider": "openai"},
        "modelProvider": "openai", "cwd": channel.workspace, "approvalPolicy": "never",
        "sandbox": sandbox}})


class FastCodexSandboxTests(unittest.TestCase):
    def test_fast_is_read_only_even_with_host_full_access(self):
        self.assertEqual(FAST_SANDBOX, ("read-only", "readOnly"))
        # Runtime asking for full access on a Fast session is refused.
        with self.assertRaises(Refused):
            start(opened(FAST), "danger-full-access")
        # The provider must confirm read-only with network off.
        for bad in ({"type": "dangerFullAccess"}, {"type": "readOnly", "networkAccess": True}):
            channel = opened(FAST)
            start(channel, "read-only")
            with self.assertRaises(Refused):
                reply(channel, bad)
        channel = opened(FAST)
        start(channel, "read-only")
        result = reply(channel, {"type": "readOnly", "networkAccess": False})
        self.assertEqual(result["result"]["frame"]["result"]["sandbox"],
                         {"type": "readOnly", "networkAccess": False})

    def test_fast_keeps_its_pinned_conversation_workspace_for_reads(self):
        channel = opened(FAST, workspaces=(PINNED,))
        start(channel, "read-only", cwd=PINNED)
        self.assertEqual(channel.workspace, PINNED)

    def test_deep_keeps_host_full_access(self):
        channel = opened(IDENTITY)
        start(channel, "danger-full-access")
        reply(channel, {"type": "dangerFullAccess"})

    def test_fast_broker_serves_only_fast_identities(self):
        with self.assertRaises(Refused):
            opened(IDENTITY, fast_only=True)
        start(opened(FAST, fast_only=True), "read-only")


class FastCodexToolTests(unittest.TestCase):
    def codex_home(self, config):
        root = Path(tempfile.mkdtemp(prefix="synthetic-fast-home-"))
        self.addCleanup(shutil.rmtree, root)
        (root / ".codex").mkdir()
        if config is not None:
            (root / ".codex/config.toml").write_text(config)
        return {"HOME": str(root), "PATH": "/usr/bin:/bin"}

    def test_fast_native_loses_every_side_effect_tool_family(self):
        from codex_service.profile import FAST_DISABLED_FEATURES, fast_host_options
        options = fast_host_options(self.codex_home(None))
        disabled = {options[i + 1] for i, value in enumerate(options) if value == "--disable"}
        self.assertEqual(disabled, set(FAST_DISABLED_FEATURES))
        for feature in SIDE_EFFECT_FEATURES:
            self.assertIn(feature, disabled)
        # Never the operator's global (Deep-class) default model.
        self.assertIn('model="gpt-6-luna"', options)
        self.assertIn('model_reasoning_effort="low"', options)

    def test_every_configured_mcp_server_is_disabled_for_fast(self):
        from codex_service.profile import fast_host_options
        environment = self.codex_home(
            'model = "synthetic"\n[mcp_servers.alpha]\ncommand = "/bin/true"\n'
            '[mcp_servers.beta-2]\nurl = "https://example.invalid/mcp"\n')
        options = fast_host_options(environment)
        self.assertIn("mcp_servers.alpha.enabled=false", options)
        self.assertIn("mcp_servers.beta-2.enabled=false", options)
        # A name a dotted override cannot address refuses the launch.
        from codex_service.contract import Refused as ContractRefused
        with self.assertRaises(ContractRefused):
            fast_host_options(self.codex_home('[mcp_servers."a.b"]\ncommand = "/bin/true"\n'))

    def test_only_the_fast_role_launches_with_restrictions(self):
        from codex_service.profile import Configuration
        environment = self.codex_home(None)
        commands = {}
        for role in ("fast", "deep", "worker-0"):
            config = object.__new__(Configuration)
            config.role, config.issued, config.host_full_access = role, False, True
            config.profile = types.SimpleNamespace(native=Path("/opt/example/native"))
            config.host_environment, config.host_environment_files = environment, []
            commands[role], descriptors = config.isolated_command()
            self.assertEqual(descriptors, ())
            self.assertEqual(commands[role][-2:], ["--listen", "stdio://"])
        fast = commands["fast"]
        self.assertEqual(fast[fast.index("/opt/example/native") + 1], "app-server")
        self.assertIn("apps", fast)
        for role in ("deep", "worker-0"):
            self.assertEqual(commands[role][-4:], ["/opt/example/native", "app-server",
                                                   "--listen", "stdio://"])

    @unittest.skipUnless(os.environ.get("ORKESTR_TEST_CODEX_NATIVE"),
                         "set ORKESTR_TEST_CODEX_NATIVE to the pinned native to check names")
    def test_disabled_feature_names_exist_in_the_pinned_native(self):
        from codex_service.profile import FAST_DISABLED_FEATURES
        with tempfile.TemporaryDirectory(prefix="synthetic-codex-home-") as home:
            listed = subprocess.run([os.environ["ORKESTR_TEST_CODEX_NATIVE"], "features", "list"],
                                    env={"PATH": "/usr/bin:/bin", "HOME": home, "CODEX_HOME": home},
                                    capture_output=True, text=True, check=True).stdout
        names = {line.split()[0] for line in listed.splitlines() if line.strip()}
        self.assertLessEqual(set(FAST_DISABLED_FEATURES), names)


class FastClaudeTests(unittest.TestCase):
    def session(self):
        root = Path(tempfile.mkdtemp(prefix="synthetic-claude-fast-")).resolve()
        self.addCleanup(shutil.rmtree, root)
        (root / "native").write_text("synthetic fixture only")
        for name in ("account", "workspace", "home", "tmp"):
            (root / name).mkdir()
        path = root / "claude-private.json"
        path.write_text(json.dumps({"executable": str(root / "native"),
            "account": str(root / "account"), "workspace": str(root / "workspace"),
            "home": str(root / "home"), "temporary": str(root / "tmp"),
            "host_full_access": {"environment": {"HOME": "/home/example", "PATH": "/usr/bin:/bin"}}}))
        return ClaudeConfiguration.load(path).new_session()

    def open(self, session, identity):
        channel = ClaudeChannel(session)
        channel.client({"id": 1, "method": "OpenOwnedSession", "params": {
            "protocol": PROTOCOL, "identity": dict(identity, provider="claude")}})
        return channel

    def test_fast_identity_launches_claude_with_read_only_tools_only(self):
        session = self.session()
        self.open(session, FAST)
        command = session.command()
        self.assertNotIn("--dangerously-skip-permissions", command)
        self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
        tools = command[command.index("--tools") + 1].split(",")
        self.assertEqual(command[command.index("--allowedTools") + 1], FAST_TOOLS)
        self.assertEqual(set(tools), {"Read", "Grep", "Glob", "WebSearch"})
        disallowed = command[command.index("--disallowedTools") + 1]
        self.assertEqual(disallowed, FAST_DISALLOWED_TOOLS)
        for tool in SIDE_EFFECT_CLAUDE_TOOLS:
            self.assertNotIn(tool, tools)
            self.assertIn(tool, disallowed.split(","))
        self.assertIn("--strict-mcp-config", command)
        self.assertEqual(json.loads(command[command.index("--mcp-config") + 1]), {"mcpServers": {}})
        self.assertEqual(json.loads(command[command.index("--settings") + 1]), {"disableAllHooks": True})
        self.assertEqual(FAST_SETTINGS, command[command.index("--settings") + 1])
        self.assertEqual(command[-2:], ["--session-id", str(session.native)])

    def test_deep_identity_keeps_host_full_access(self):
        session = self.session()
        self.open(session, IDENTITY)
        self.assertIn("--dangerously-skip-permissions", session.command())

    def test_restriction_cannot_follow_a_launch_and_is_required_for_fast(self):
        session = self.session()
        session.owned_spawned(object())
        with self.assertRaises(ValueError):
            session.restrict_to_read_only()
        # A session object that cannot become read-only never serves Fast.
        unrestricted = types.SimpleNamespace(native="44444444-4444-4444-8444-444444444444")
        with self.assertRaises(Refused):
            self.open(unrestricted, FAST)


if __name__ == "__main__":
    unittest.main()
