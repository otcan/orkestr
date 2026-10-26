"""Separate trusted Claude launcher profile; not a Codex protocol fallback.

No production route registers this profile yet. Installed CLI flag compatibility,
account entitlement proof and Claude control codec remain activation gates.
"""
from dataclasses import dataclass
from pathlib import Path
import uuid
import json

PATHS = ("executable", "account", "workspace", "home", "temporary")
# Fast runs in parallel with Deep on the same input, so it is read-only: only
# these read-only built-in tools exist, they are the only pre-approved ones
# (dontAsk denies everything else), no MCP server is loaded and no hook runs.
FAST_TOOLS = "Read,Grep,Glob,WebSearch"
FAST_DISALLOWED_TOOLS = "Bash,Edit,Write,NotebookEdit,WebFetch,Task,Agent,TodoWrite,Skill,SlashCommand"
FAST_SETTINGS = '{"disableAllHooks":true}'
EFFORTS = ("low", "medium", "high", "max")


def turn_preferences(source):
    """Owner model/effort from the trusted Runtime launch (closed values)."""
    selected = {}
    model, effort = source.get("ORKESTR_CLAUDE_MODEL"), source.get("ORKESTR_CLAUDE_EFFORT")
    if model is not None:
        if not (0 < len(model) <= 120 and all(c.isascii() and (c.isalnum() or c in "._:-") for c in model)
                and not model.isdigit()):
            raise ValueError("invalid Claude model preference")
        selected["ANTHROPIC_MODEL"] = model
    if effort is not None:
        if effort not in EFFORTS:
            raise ValueError("invalid Claude effort preference")
        selected["CLAUDE_CODE_EFFORT_LEVEL"] = effort
    return selected


def host_environment(value):
    """Operator-only real executor environment for host full access."""
    if not isinstance(value, dict) or set(value) != {"environment"}:
        raise ValueError("invalid host full access configuration")
    environment = value["environment"]
    if not isinstance(environment, dict) or not {"HOME", "PATH"} <= set(environment) \
            or len(environment) > 256 or not all(
                isinstance(k, str) and isinstance(v, str) and k and "=" not in k
                and "\0" not in k + v and len(v) <= 16384 for k, v in environment.items()) \
            or not Path(environment["HOME"]).is_absolute():
        raise ValueError("invalid host full access environment")
    # Account selection stays with the configured account reference: an
    # inherited key/token would silently switch billing route or account.
    if {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CONFIG_DIR"} & set(environment):
        raise ValueError("host full access environment cannot select an account")
    return dict(environment)


@dataclass(frozen=True)
class ClaudeConfiguration:
    executable: Path
    account: Path
    workspace: Path
    home: Path
    temporary: Path
    # Operator instance opt-in (V1-equivalent YOLO): no namespace wrapper,
    # --dangerously-skip-permissions and the full default tool set.
    host_full_access: dict = None

    @classmethod
    def load(cls, path):
        value = json.loads(Path(path).read_text())
        if not isinstance(value, dict) or set(value) - {"host_full_access"} != set(PATHS):
            raise ValueError("invalid private Claude configuration")
        access = value.pop("host_full_access", None)
        config = cls(**{key: Path(item) for key, item in value.items()},
                     host_full_access=None if access is None else host_environment(access))
        config.validate()
        return config

    def validate(self):
        for name in PATHS:
            path = getattr(self, name)
            if not isinstance(path, Path) or not path.is_absolute():
                raise ValueError("invalid trusted Claude configuration")
            if path.resolve(strict=True) != path:
                raise ValueError("noncanonical trusted Claude configuration")
            if not (path.is_file() if name == "executable" else path.is_dir()):
                raise ValueError("invalid trusted Claude path")

    def resumed_session(self, specification, account_environment=None):
        # Private lifecycle spec only; caller additionally needs Core resume authority.
        from claude_resume import ResumeSpec
        if type(specification) is not ResumeSpec:
            raise ValueError("invalid private resume specification")
        native = specification._take(self)
        self.validate()
        return ClaudeOwnedSession(self, native, account_environment, resumed=True)

    def new_session(self, account_environment=None):
        self.validate()
        # Server-generated identity only; no resume/adoption or client UUID.
        return ClaudeOwnedSession(self, uuid.uuid4(), account_environment)


class ClaudeOwnedSession:
    """Fresh fixed stream-JSON process specification, server-private only.

    Pump can transfer this process's sole stdin using the same private FD
    primitive. A separate reviewed Claude channel must validate system/init,
    exact UUID and terminal/result before any persistent follow-up. This object
    grants neither inference nor cancellation authority.
    """
    def __init__(self, config, native, account_environment=None, resumed=False):
        self._config, self.native = config, native
        self.workspace = config.workspace
        self._account_environment = account_environment
        self.resumed = resumed
        self.read_only = False
        self._owned_child = None
        self._retired = False

    def restrict_to_read_only(self):
        """Fast identity: one-way, and only before the native is launched."""
        if self._owned_child is not None:
            raise ValueError("Claude process already launched")
        self.read_only = True

    def owned_spawned(self, child):
        if self._owned_child is not None:
            raise ValueError("owned Claude process already issued")
        self._owned_child = child

    @property
    def max_provider_frame(self):
        # Full-access init/tool-result frames carry real settings and outputs.
        return 4 * 1024 * 1024 if self.uncontained else 65536

    @property
    def uncontained(self):
        """Host full access launches the native directly, like V1 executors."""
        return self._config.host_full_access is not None

    def command(self):
        session = ["--resume" if self.resumed else "--session-id", str(self.native)]
        if self.uncontained and self.read_only:
            return [str(self._config.executable), "-p", "--input-format", "stream-json",
                    "--output-format", "stream-json", "--verbose",
                    "--permission-mode", "dontAsk", "--tools", FAST_TOOLS,
                    "--allowedTools", FAST_TOOLS, "--disallowedTools", FAST_DISALLOWED_TOOLS,
                    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                    "--settings", FAST_SETTINGS, "--disable-slash-commands", "--no-chrome",
                    "--prompt-suggestions", "false", *session]
        if self.uncontained:
            return [str(self._config.executable), "-p", "--input-format", "stream-json",
                    "--output-format", "stream-json", "--verbose",
                    "--dangerously-skip-permissions", "--no-chrome",
                    "--prompt-suggestions", "false", *session]
        return [str(self._config.executable), "-p", "--input-format", "stream-json",
                "--output-format", "stream-json", "--verbose",
                "--permission-mode", "dontAsk", "--permission-prompts", "none",
                "--safe-mode", "--restricted", "--disable-slash-commands",
                "--no-chrome", "--prompt-suggestions", "false", "--tools", "",
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--setting-sources", "",
                "--resume" if self.resumed else "--session-id", str(self.native)]

    def environment(self):
        # Existing canonical auth stays INSIDE this trusted connector. No token,
        # profile copy, inherited API key, resume ID or worker-visible locator.
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                "HOME": str(self._config.home), "TMPDIR": str(self._config.temporary),
                "CLAUDE_CONFIG_DIR": str(self._config.account)}
        if self.uncontained:
            # The real executor environment; the account reference still wins.
            # Each turn is a new process, so detached background tasks would be
            # killed while the turn reports completion (same reason as V1).
            environment = dict(self._config.host_full_access,
                               CLAUDE_CONFIG_DIR=str(self._config.account),
                               CLAUDE_CODE_DISABLE_BACKGROUND_TASKS="1")

        import os
        environment.update(turn_preferences(os.environ))
        if self._account_environment is not None:
            # Trusted launcher-side callback only, never protocol/config JSON.
            # Root resolves the existing selected account at acceptance/runtime.
            selected = self._account_environment()
            if not isinstance(selected, dict) or set(selected) != {"CLAUDE_CODE_OAUTH_TOKEN"}:
                raise ValueError("invalid selected subscription environment")
            token = selected["CLAUDE_CODE_OAUTH_TOKEN"]
            if not isinstance(token, str) or not token or "\0" in token:
                raise ValueError("invalid selected subscription environment")
            environment.update(selected)
        return environment
