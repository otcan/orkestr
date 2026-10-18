#!/usr/bin/env python3
"""Assemble a directory package from an existing native binary; never build/download."""
import argparse
import os
from pathlib import Path
import platform
import re
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-install"))
from install_state import PACKAGE_FORMAT, files, fresh_path, package, unprivileged, write_json
from helper import require

TOOLS = ("helper.py", "install_state.py", "launcher.py", "recovery.py", "path_identity.py")


def assemble(binary, output, version, source_commit, ui=None):
    unprivileged()
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", version), "invalid package version")
    require(re.fullmatch(r"[0-9a-f]{40}", source_commit), "full source commit required")
    binary = Path(binary).resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), "existing executable required")
    ui = Path(ui).resolve() if ui else None
    if ui:
        require((ui / "index.html").is_file(), "UI dist requires index.html")
        files(ui)  # Reject symlinks/special files before copying.
    output = fresh_path(output, [binary] + ([ui] if ui else []))
    output.mkdir(mode=0o700)
    (output / "server").mkdir()
    shutil.copy2(binary, output / "server" / "orkestr-v2-server")
    (output / "tools").mkdir()
    source = Path(__file__).resolve().parents[1] / "local-install"
    for name in TOOLS:
        shutil.copy2(source / name, output / "tools" / name)
    (output / "bin").mkdir()
    entrypoint = output / "bin" / "orkestr-v2"
    entrypoint.write_text('#!/bin/sh\nset -eu\nexec python3 -B "$(CDPATH= cd -- "$(dirname -- "$0")/../tools" && pwd)/launcher.py" "$@"\n')
    entrypoint.chmod(0o755)
    if ui:
        shutil.copytree(ui, output / "ui")
    write_json(output / "manifest.json", {
        "format": PACKAGE_FORMAT, "version": version, "source_commit": source_commit,
        "target": f"{platform.system().lower()}-{platform.machine().lower()}",
        "schema_compatibility": "unverified; server-owned migrations apply only on explicit start",
        "ui": bool(ui), "files": files(output),
    })
    package(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--ui-dist")
    args = parser.parse_args()
    try:
        print(assemble(args.binary, args.output, args.version, args.source_commit, args.ui_dist))
    except (OSError, RuntimeError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
