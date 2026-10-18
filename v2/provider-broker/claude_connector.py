"""Separate trusted Claude launcher profile; not a Codex protocol fallback.

No production route registers this profile yet. Installed CLI flag compatibility,
account entitlement proof and Claude control codec remain activation gates.
"""
from dataclasses import dataclass
from pathlib import Path
import uuid
import json


@dataclass(frozen=True)
class ClaudeConfiguration:
    executable: Path
    account: Path
    workspace: Path
    home: Path
    temporary: Path

    @classmethod
    def load(cls, path):
        value = json.loads(Path(path).read_text())
        if not isinstance(value, dict) or set(value) != set(cls.__dataclass_fields__):
            raise ValueError("invalid private Claude configuration")
        config = cls(**{key: Path(item) for key, item in value.items()})
        config.validate()
        return config

    def validate(self):
        for name in self.__dataclass_fields__:
            path = getattr(self, name)
            if not isinstance(path, Path) or not path.is_absolute():
                raise ValueError("invalid trusted Claude configuration")
            if path.resolve(strict=True) != path:
                raise ValueError("noncanonical trusted Claude configuration")
            if not (path.is_file() if name == "executable" else path.is_dir()):
                raise ValueError("invalid trusted Claude path")

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
    def __init__(self, config, native, account_environment=None):
        self._config, self.native = config, native
        self.workspace = config.workspace
        self._account_environment = account_environment

    def command(self):
        return [str(self._config.executable), "-p", "--input-format", "stream-json",
                "--output-format", "stream-json", "--verbose",
                "--permission-mode", "dontAsk", "--permission-prompts", "none",
                "--safe-mode", "--restricted", "--disable-slash-commands",
                "--no-chrome", "--prompt-suggestions", "false", "--tools", "",
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--setting-sources", "", "--session-id", str(self.native)]

    def environment(self):
        # Existing canonical auth stays INSIDE this trusted connector. No token,
        # profile copy, inherited API key, resume ID or worker-visible locator.
        environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                "HOME": str(self._config.home), "TMPDIR": str(self._config.temporary),
                "CLAUDE_CONFIG_DIR": str(self._config.account)}

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
