"""Container-only startup; never invoke the native archive installer on overlay."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat


def checked(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify(root):
    manifest = json.loads((root / "artifact-manifest.json").read_text())
    inventory = manifest["files"]
    actual = {}
    for parent in (root / "server", root / "ui"):
        checked(not parent.is_symlink(), "image artifact root symlink refused")
        for path in sorted(parent.rglob("*")) if parent.is_dir() else [parent]:
            checked(not path.is_symlink() and (path.is_dir() or path.is_file()), "invalid image artifact")
            if path.is_file():
                actual[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    for name in ("entrypoint.py", "dormant.py"):
        checked(not (root / name).is_symlink(), "image tool symlink refused")
        actual[name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
    checked(actual == inventory, "image artifact checksum mismatch")
    return manifest


def environment(root, state, incoming):
    manifest = verify(root)
    origin = incoming.get("ORKESTR_V2_ORIGIN", "")
    checked(origin == manifest["origin"], "exact configured browser origin required")
    opt_in = manifest["container_bind_opt_in"]
    checked(incoming.get(opt_in["name"]) == opt_in["value"], "reviewed runtime container bind opt-in required")
    checked(state.is_dir() and not state.is_symlink(), "explicit state volume required")
    checked(state.stat().st_uid == os.getuid() and stat.S_IMODE(state.stat().st_mode) == 0o700,
            "state volume must be owned by runtime user and private")
    marker = state / "restore-dormant.json"
    checked(not marker.exists() and not marker.is_symlink(), "dormant restore prohibits activation; rollback required")
    for name in ("control", "data", "provider-home"):
        path = state / name
        if not path.exists():
            path.mkdir(mode=0o700)
        checked(not path.is_symlink() and path.is_dir() and path.stat().st_uid == os.getuid()
                and stat.S_IMODE(path.stat().st_mode) == 0o700, "invalid private container state layout")
    token = state / "control/bootstrap.token"
    if not token.exists() and not token.is_symlink():
        fd = os.open(token, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_urlsafe(48))
    checked(not token.is_symlink() and token.is_file() and token.stat().st_uid == os.getuid()
            and token.stat().st_nlink == 1 and stat.S_IMODE(token.stat().st_mode) == 0o600,
            "invalid private container bootstrap file")
    bootstrap = token.read_text()
    checked(len(bootstrap) >= 32, "invalid bootstrap file")
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(state / "provider-home"),
            "ORKESTR_V2_HOME": str(state / "data"), "ORKESTR_V2_BIND": "0.0.0.0:19822",
            "ORKESTR_V2_ORIGIN": origin, "ORKESTR_V2_UI_DIST": str(root / "ui"),
            "ORKESTR_V2_BOOTSTRAP_TOKEN": bootstrap, opt_in["name"]: opt_in["value"]}


if __name__ == "__main__":
    root = Path("/opt/v2")
    env = environment(root, Path("/state"), os.environ)
    os.execve(root / "server", [str(root / "server")], env)
