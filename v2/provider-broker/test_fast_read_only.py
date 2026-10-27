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

    def test_fast_thread_model_uses_the_turn_model_rule(self):
        base = {"approvalPolicy": "never", "sandbox": "read-only", "ephemeral": False,
                "modelProvider": "openai"}
        def begin(model):
            channel = opened(FAST)
            return request(channel, {"id": 3, "method": "thread/start", "params": {
                **base, "cwd": channel.workspace, "model": model}}, outer=5)
        begin("gpt-6-luna")
        for model in ("vendor/model", "123", "openai", "Azure", "openrouter", "a b", ""):
            with self.assertRaises(Refused):
                begin(model)

    def test_fast_broker_serves_only_read_only_identities(self):
        with self.assertRaises(Refused):
            opened(dict(IDENTITY, role="worker"), fast_only=True)
        start(opened(FAST, fast_only=True), "read-only")

    def test_parallel_deep_on_the_read_only_broker_stays_read_only(self):
        # A read-only parallel Deep slot runs on the Fast service broker:
        # Runtime asking for full access is refused even on host full access,
        # and the provider must confirm read-only with network off.
        channel = opened(IDENTITY, fast_only=True)
        self.assertTrue(channel.parallel_deep)
        with self.assertRaises(Refused):
            start(channel, "danger-full-access")
        for bad in ({"type": "dangerFullAccess"}, {"type": "readOnly", "networkAccess": True}):
            channel = opened(IDENTITY, fast_only=True)
            start(channel, "read-only")
            with self.assertRaises(Refused):
                reply(channel, bad)
        channel = opened(IDENTITY, fast_only=True)
        start(channel, "read-only")
        reply(channel, {"type": "readOnly", "networkAccess": False})
        # The ordinary Deep broker is unchanged.
        self.assertFalse(opened(IDENTITY).parallel_deep)

    def test_parallel_deep_on_the_read_only_broker_is_never_resumed(self):
        native = "00000000-0000-4000-8000-000000000123"
        channel = Channel(WORKSPACE, host_full_access=True, fast_only=True, expected_native=native)
        with self.assertRaises(Refused):
            channel.client({"id": 1, "method": "OpenOwnedSession",
                            "params": {"protocol": PROTOCOL, "identity": dict(IDENTITY)}})
        # A Fast identity on the same broker may still resume its own native.
        channel = Channel(WORKSPACE, host_full_access=True, fast_only=True, expected_native=native)
        channel.client({"id": 1, "method": "OpenOwnedSession",
                        "params": {"protocol": PROTOCOL, "identity": dict(FAST)}})


NATIVE_ENV = "ORKESTR_TEST_CODEX_NATIVE"
REPO_V2 = Path(__file__).resolve().parent.parent


class FastCodexToolTests(unittest.TestCase):
    def tree(self):
        root = Path(tempfile.mkdtemp(prefix="synthetic-fast-home-"))
        self.addCleanup(shutil.rmtree, root)
        operator = root / "operator/.codex"
        (operator / "rules").mkdir(parents=True)
        (operator / "auth.json").write_text("{}")
        os.chmod(operator / "auth.json", 0o600)
        # The operator's own layers that must never reach Fast.
        (operator / "config.toml").write_text('[mcp_servers.alpha]\ncommand = "/bin/true"\n')
        (operator / "rules/default.rules").write_text(
            'prefix_rule(pattern=["tmux"], decision="allow")\n')
        state = root / "native-fast"
        state.mkdir(mode=0o700)
        return root, operator, state

    def test_fast_native_loses_every_side_effect_tool_family(self):
        from codex_service.profile import FAST_DISABLED_FEATURES, fast_host_options
        options = fast_host_options()
        disabled = {options[i + 1] for i, value in enumerate(options) if value == "--disable"}
        self.assertEqual(disabled, set(FAST_DISABLED_FEATURES))
        for feature in SIDE_EFFECT_FEATURES + ("hooks",):
            self.assertIn(feature, disabled)
        # Never the operator's global (Deep-class) default model.
        self.assertIn('model="gpt-6-luna"', options)
        self.assertIn('model_reasoning_effort="low"', options)

    def test_fast_home_holds_only_auth_and_no_operator_layers(self):
        from codex_service.profile import FAST_HOME_FORBIDDEN, prepare_fast_home
        root, operator, state = self.tree()
        system = root / "etc-codex"
        home = prepare_fast_home(state / "host-codex-home", operator / "auth.json", system)
        self.assertEqual(sorted(p.name for p in home.iterdir()), ["auth.json"])
        # One shared credential: a link to the operator's auth file.
        self.assertTrue((home / "auth.json").is_symlink())
        self.assertEqual(os.readlink(home / "auth.json"), str(operator / "auth.json"))
        self.assertEqual(os.stat(home).st_mode & 0o777, 0o700)
        # Anything Codex (or anyone) left there is removed before each launch.
        for name in FAST_HOME_FORBIDDEN:
            target = home / name
            if name in ("rules", "hooks", "plugins"):
                target.mkdir()
                (target / "default.rules").write_text('prefix_rule(pattern=["x"], decision="allow")\n')
            else:
                target.write_text("[mcp_servers.beta]\ncommand = '/bin/true'\n")
        prepare_fast_home(home, operator / "auth.json", system)
        self.assertEqual(sorted(p.name for p in home.iterdir()), ["auth.json"])

    def test_reachable_allow_rules_or_system_layers_refuse_the_launch(self):
        from codex_service.contract import Refused as ContractRefused
        from codex_service.profile import prepare_fast_home, reachable_allow_rules
        root, operator, state = self.tree()
        system = root / "etc-codex"
        (system / "rules").mkdir(parents=True)
        (system / "rules/site.rules").write_text('prefix_rule(pattern=["ls"], decision="prompt")\n')
        prepare_fast_home(state / "home", operator / "auth.json", system)
        (system / "rules/site.rules").write_text("prefix_rule(pattern=['tmux'], decision = 'allow')\n")
        self.assertEqual(reachable_allow_rules(state / "home", system), [system / "rules/site.rules"])
        with self.assertRaises(ContractRefused):
            prepare_fast_home(state / "home", operator / "auth.json", system)
        (system / "rules/site.rules").unlink()
        (system / "managed_config.toml").write_text("[mcp_servers.x]\nurl='http://127.0.0.1:1'\n")
        with self.assertRaises(ContractRefused):
            prepare_fast_home(state / "home", operator / "auth.json", system)
        # A shared or foreign-writable home is refused, never repaired.
        (system / "managed_config.toml").unlink()
        os.chmod(state / "home", 0o755)
        with self.assertRaises(ContractRefused):
            prepare_fast_home(state / "home", operator / "auth.json", system)

    @staticmethod
    def expected_home(operator, state):
        from codex_service.profile import fast_home
        return fast_home(types.SimpleNamespace(state_root=str(state)), {"HOME": str(operator.parent)})

    def configuration(self, role, operator, state, files=()):
        from codex_service.profile import Configuration
        config = object.__new__(Configuration)
        config.role, config.issued, config.host_full_access = role, False, True
        config.profile = types.SimpleNamespace(native=Path("/opt/example/native"),
                                               state_root=str(state))
        config.host_environment = {"HOME": str(operator.parent), "PATH": "/usr/bin:/bin",
                                   "CODEX_HOME": str(operator)}
        config.host_environment_files = list(files)
        return config

    def test_only_the_fast_role_launches_with_its_own_home_and_restrictions(self):
        root, operator, state = self.tree()
        commands = {}
        for role in ("fast", "deep", "worker-0"):
            commands[role], descriptors = self.configuration(role, operator, state).isolated_command()
            self.assertEqual(descriptors, ())
            self.assertEqual(commands[role][-2:], ["--listen", "stdio://"])
        fast = commands["fast"]
        native = fast.index("/opt/example/native")
        self.assertEqual(fast[native - 2:native], ["/usr/bin/env",
                         f"CODEX_HOME={self.expected_home(operator, state)}"])
        self.assertEqual(fast[native + 1], "app-server")
        self.assertIn("hooks", fast)
        for role in ("deep", "worker-0"):
            self.assertEqual(commands[role][-4:], ["/opt/example/native", "app-server",
                                                   "--listen", "stdio://"])
            self.assertIn(f"CODEX_HOME={operator}", commands[role])
            self.assertNotIn(f"CODEX_HOME={self.expected_home(operator, state)}", commands[role])

    def test_an_environment_file_cannot_move_fast_back_to_the_operator_home(self):
        root, operator, state = self.tree()
        env = root / "tool.env"
        env.write_text(f"CODEX_HOME={operator}\n")
        env.chmod(0o600)
        native = root / "native"
        native.write_text('#!/bin/sh\nprintf %s "$CODEX_HOME"\n')
        native.chmod(0o700)
        config = self.configuration("fast", operator, state, [str(env)])
        config.profile.native = native
        command, _ = config.isolated_command()
        output = subprocess.run(command, capture_output=True, text=True, check=True).stdout
        self.assertEqual(output, str(self.expected_home(operator, state)))

    def test_fast_resume_finds_threads_from_before_its_own_home(self):
        root, operator, state = self.tree()
        native = "01a15956-93a3-7730-83a6-84853f05bb69"
        rollout = operator / "sessions/2026/10/20" / f"rollout-2026-10-20T12-00-00-{native}.jsonl"
        rollout.parent.mkdir(parents=True)
        rollout.write_bytes(b'{"synthetic":1}\n')
        config = self.configuration("fast", operator, state)
        self.assertEqual(config.host_resume(native), "imported")
        self.assertTrue((self.expected_home(operator, state) / "sessions/2026/10/20" / rollout.name).is_file())
        self.assertEqual(config.host_resume(native), "present")

    def test_disabled_feature_list_is_verified_for_the_pinned_native(self):
        """Required on every Codex upgrade: bump FAST_FEATURES_VERIFIED_FOR only
        after running this test with ORKESTR_TEST_CODEX_NATIVE set."""
        import json as _json
        from codex_service.profile import FAST_DISABLED_FEATURES, FAST_FEATURES_VERIFIED_FOR
        pins = _json.loads((REPO_V2 / "packaging/desktop/codex-pins.json").read_text())
        self.assertEqual(pins["version"], FAST_FEATURES_VERIFIED_FOR,
                         "Codex native upgraded: re-verify FAST_DISABLED_FEATURES with "
                         f"{NATIVE_ENV}=<native> and the Fast home probe, then update "
                         "FAST_FEATURES_VERIFIED_FOR")
        native = os.environ.get(NATIVE_ENV)
        if not native:
            return
        with tempfile.TemporaryDirectory(prefix="synthetic-codex-home-") as home:
            run = subprocess.run([native, "--version"], env={"PATH": "/usr/bin:/bin", "HOME": home,
                                 "CODEX_HOME": home}, capture_output=True, text=True, check=True)
            self.assertIn(FAST_FEATURES_VERIFIED_FOR, run.stdout)
            listed = subprocess.run([native, "features", "list"],
                                    env={"PATH": "/usr/bin:/bin", "HOME": home, "CODEX_HOME": home},
                                    capture_output=True, text=True, check=True).stdout
        names = {line.split()[0] for line in listed.splitlines() if line.strip()}
        self.assertLessEqual(set(FAST_DISABLED_FEATURES), names)

    @unittest.skipUnless(os.environ.get(NATIVE_ENV), "needs the pinned native")
    def test_pinned_native_ignores_project_layers_without_operator_trust(self):
        """A trusted workspace's `.codex/config.toml`, rules and hooks stay
        disabled in the Fast home (no config.toml, so no trusted project)."""
        root, operator, state = self.tree()
        project = root / "workspace"
        (project / ".codex/rules").mkdir(parents=True)
        (project / ".codex/config.toml").write_text('[mcp_servers.project]\ncommand = "/bin/true"\n')
        (project / ".codex/rules/default.rules").write_text(
            'prefix_rule(pattern=["tmux"], decision="allow")\n')
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        from codex_service.profile import prepare_fast_home
        home = prepare_fast_home(state / "home", operator / "auth.json", root / "etc-codex")
        child = subprocess.Popen([os.environ[NATIVE_ENV], "app-server", "--listen", "stdio://"],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, cwd=project, text=True,
                                 env={"PATH": "/usr/bin:/bin", "HOME": str(root),
                                      "CODEX_HOME": str(home)})
        try:
            def call(ident, method, params):
                child.stdin.write(json.dumps({"id": ident, "method": method, "params": params}) + "\n")
                child.stdin.flush()
                while True:
                    value = json.loads(child.stdout.readline())
                    if value.get("id") == ident:
                        return value
            call(1, "initialize", {"clientInfo": {"name": "synthetic", "title": "Synthetic",
                 "version": "1"}, "capabilities": {"experimentalApi": False}})
            child.stdin.write(json.dumps({"method": "initialized"}) + "\n")
            result = call(2, "config/read", {"cwd": str(project), "includeLayers": True})["result"]
        finally:
            child.kill()
            child.wait()
            child.stdin.close()
            child.stdout.close()
        self.assertFalse((result["config"].get("mcp_servers") or {}))
        project_layers = [layer for layer in result["layers"] if layer["name"]["type"] == "project"]
        self.assertTrue(project_layers)
        self.assertTrue(all(layer.get("disabledReason") for layer in project_layers))


class FastHomeRegressionTests(unittest.TestCase):
    """Incident 2026-10-26: a Fast home inside the Fast native state root made
    every later Fast launch fail `private_state` ("unexpected private native
    state"). The home must live outside every checked tree."""

    @staticmethod
    def private_base():
        """private_state requires ancestors writable only by root or us
        (/tmp is not); use the first such base directory."""
        for candidate in (os.environ.get("ORKESTR_V2_HOME"), os.environ.get("HOME")):
            if not candidate or not Path(candidate).is_dir():
                continue
            path = Path(candidate).resolve()
            if all(item.stat().st_uid in (0, os.geteuid()) and not item.stat().st_mode & 0o022
                   for item in (path, *path.parents)):
                return path
        return None

    def layout(self):
        base = self.private_base()
        if base is None:
            self.skipTest("no private base directory for the real private_state check")
        root = Path(tempfile.mkdtemp(prefix="synthetic-fast-state-", dir=base))
        self.addCleanup(shutil.rmtree, root)
        operator = root / "home/.codex"
        operator.mkdir(parents=True, mode=0o700)
        (operator / "auth.json").write_text('{"synthetic": "token-a"}')
        os.chmod(operator / "auth.json", 0o600)
        state = root / "native-fast"
        state.mkdir(mode=0o700)
        # The real production layout of a used Fast state root.
        (state / "sessions/2026/10/26").mkdir(parents=True, mode=0o700)
        for name in ("sessions", "sessions/2026", "sessions/2026/10", "sessions/2026/10/26"):
            os.chmod(state / name, 0o700)
        for name in ("state_5.sqlite", "logs_2.sqlite", "installation_id"):
            (state / name).write_bytes(b"synthetic")
            os.chmod(state / name, 0o600)
        (state / "auth.json").write_bytes(b"")
        os.chmod(state / "auth.json", 0o600)
        for name in ("tmp", "cache"):
            (state / name).mkdir(mode=0o700)
        return root, operator, state

    def configuration(self, operator, state):
        from codex_service.profile import Configuration
        config = object.__new__(Configuration)
        config.role, config.issued, config.host_full_access = "fast", False, True
        config.profile = types.SimpleNamespace(native=Path("/opt/example/native"),
                                               state_root=str(state))
        config.host_environment = {"HOME": str(operator.parent), "PATH": "/usr/bin:/bin",
                                   "CODEX_HOME": str(operator)}
        config.host_environment_files = []
        return config

    def test_real_private_state_accepts_the_state_root_after_fast_launches(self):
        from isolation.authenticated import private_state
        root, operator, state = self.layout()
        private_state(str(state))  # Sanity: the fixture is a valid state root.
        for _ in range(3):  # Every launch prepares the home, then the next loads the profile.
            config = self.configuration(operator, state)
            config.isolated_command()
            private_state(str(state))
        home = config.prepare_fast_home()
        self.assertNotIn(state, home.parents)
        self.assertNotIn(operator, home.parents)
        self.assertEqual(sorted(p.name for p in state.iterdir()),
                         ["auth.json", "cache", "installation_id", "logs_2.sqlite",
                          "sessions", "state_5.sqlite", "tmp"])
        # The old location is exactly what private_state refuses.
        (state / "host-codex-home").mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, "unexpected private native state"):
            private_state(str(state))

    def test_a_home_inside_a_checked_tree_is_refused(self):
        from codex_service.contract import Refused as ContractRefused
        from codex_service import profile
        root, operator, state = self.layout()
        config = self.configuration(operator, state)
        for inside in (state / "host-codex-home", operator / "fast"):
            original = profile.fast_home
            profile.fast_home = lambda *_: inside
            try:
                with self.assertRaises(ContractRefused):
                    config.prepare_fast_home()
            finally:
                profile.fast_home = original

    def test_auth_link_resolves_to_the_operator_file_and_state_stays_valid(self):
        from isolation.authenticated import private_state
        root, operator, state = self.layout()
        config = self.configuration(operator, state)
        home = config.prepare_fast_home()
        link = home / "auth.json"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(strict=True), (operator / "auth.json").resolve(strict=True))
        # A refresh written by either native is the credential the other reads.
        (operator / "auth.json").write_text('{"synthetic": "token-b"}')
        self.assertEqual(link.read_text(), '{"synthetic": "token-b"}')
        private_state(str(state))
        # A replaced or retargeted link is restored on the next launch.
        link.unlink()
        link.write_text('{"synthetic": "stale"}')
        config.prepare_fast_home()
        self.assertEqual(os.readlink(link), str(operator / "auth.json"))
        private_state(str(state))
        # The operator file must be ours and private, or Fast does not launch.
        from codex_service.contract import Refused as ContractRefused
        os.chmod(operator / "auth.json", 0o644)
        with self.assertRaises(ContractRefused):
            config.prepare_fast_home()


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
        self.assertEqual(command[command.index("--setting-sources") + 1], "")
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
