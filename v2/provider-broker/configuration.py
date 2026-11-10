"""Server-private installation configuration; never accepts client configuration."""
from dataclasses import dataclass
from pathlib import Path
import json


@dataclass(frozen=True)
class Configuration:
    codex_executable: Path
    codex_home: Path
    workspace: Path
    home: Path
    temporary: Path

    @classmethod
    def load(cls, path):
        value = json.loads(Path(path).read_text())
        fields = set(cls.__dataclass_fields__)
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError("invalid private configuration")
        paths = {}
        for field in fields:
            item = Path(value[field])
            if not item.is_absolute() or item.resolve(strict=True) != item:
                raise ValueError("noncanonical private configuration")
            if field == "codex_executable":
                if not item.is_file():
                    raise ValueError("invalid executable")
            elif not item.is_dir():
                raise ValueError("invalid directory")
            paths[field] = item
        return cls(**paths)

    def environment(self):
        # CODEX_HOME points at the canonical existing account INSIDE this trusted
        # connector only. No token, account directory or inherited env crosses
        # the parent pipe. This is not same-UID filesystem/proc isolation.
        return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                "HOME": str(self.home), "TMPDIR": str(self.temporary),
                "CODEX_HOME": str(self.codex_home)}

    def command(self):
        return [str(self.codex_executable), "app-server", "--listen", "stdio://"]
