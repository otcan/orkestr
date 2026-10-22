#!/usr/bin/env python3
"""Build the self-contained Orkestr V2 bundle: server binary plus web UI.

Output: <out>/orkestr-v2-<version>-<target>/ and a reproducible .tar.gz of it
(sorted entries, fixed owner, mtime from SOURCE_DATE_EPOCH or the commit time).
With --desktop it also stages the sidecars and UI resources the Tauri shell in
apps/desktop bundles: the server, the pinned official Codex CLI and ui/.

Cargo runs through $V2_CARGO (default: cargo) with --locked; pass --offline
when the registry cache is already populated. Nothing is published.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[1]
DESKTOP = WORKSPACE / "apps" / "desktop"
sys.path.insert(0, str(HERE))
import fetch_codex  # noqa: E402


class BundleError(Exception):
    pass


def run(command, **kwargs):
    print("+", " ".join(str(part) for part in command), file=sys.stderr, flush=True)
    subprocess.run(command, check=True, **kwargs)


def host_target():
    output = subprocess.run(["rustc", "-vV"], check=True, capture_output=True, text=True).stdout
    return next(line.split(": ", 1)[1] for line in output.splitlines() if line.startswith("host: "))


def workspace_version():
    import tomllib
    return tomllib.loads((WORKSPACE / "Cargo.toml").read_text())["workspace"]["package"]["version"]


def source_epoch():
    if os.environ.get("SOURCE_DATE_EPOCH"):
        return int(os.environ["SOURCE_DATE_EPOCH"])
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%ct"], cwd=WORKSPACE, check=True,
                             capture_output=True, text=True).stdout.strip()
        return int(out)
    except (OSError, subprocess.CalledProcessError, ValueError):
        return 0


def source_commit():
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=WORKSPACE, check=True,
                              capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def exe(name, target):
    return f"{name}.exe" if "windows" in target else name


def build_server(target, offline, target_dir):
    cargo = os.environ.get("V2_CARGO", "cargo")
    command = [cargo, "build", "--release", "--locked", "-p", "orkestr-v2-server", "--target", target]
    if offline:
        command.append("--offline")
    run(command, cwd=WORKSPACE, env={**os.environ, "CARGO_TARGET_DIR": str(target_dir)})
    return target_dir / target / "release" / exe("orkestr-v2-server", target)


def build_ui(ui_dir, target_dir):
    env = {**os.environ, "CARGO_TARGET_DIR": str(target_dir), "UI_BUNDLE_DIR": str(ui_dir),
           "V2_CARGO": os.environ.get("V2_CARGO", "cargo")}
    run(["bash", str(WORKSPACE / "apps" / "ui" / "scripts" / "bundle.sh")], env=env)
    return ui_dir


def regular_files(root):
    files = []
    for path in sorted(Path(root).rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise BundleError(f"refusing special file {path}")
        if path.is_file():
            files.append(path)
    return files


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stage(server, ui, out, version, target):
    name = f"orkestr-v2-{version}-{target}"
    root = Path(out) / name
    if root.exists():
        shutil.rmtree(root)
    (root / "bin").mkdir(parents=True)
    if not (Path(ui) / "index.html").is_file():
        raise BundleError("UI bundle requires index.html")
    regular_files(ui)  # refuse symlinks and special files before copying
    shutil.copy2(server, root / "bin" / exe("orkestr-v2-server", target))
    (root / "bin" / exe("orkestr-v2-server", target)).chmod(0o755)
    shutil.copytree(ui, root / "ui")
    license_file = WORKSPACE.parent / "LICENSE"
    if license_file.is_file():
        shutil.copy2(license_file, root / "LICENSE")
    manifest = {
        "schema": 1,
        "product": "orkestr-v2",
        "version": version,
        "target": target,
        "source_commit": source_commit(),
        "files": {path.relative_to(root).as_posix(): digest(path) for path in regular_files(root)},
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return root


def archive(root, epoch):
    """Byte-reproducible tar.gz of a staged bundle."""
    root = Path(root)
    destination = root.with_name(root.name + ".tar.gz")
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        entries = [root] + sorted(root.rglob("*"))
        for path in entries:
            info = tar.gettarinfo(str(path), arcname=Path(root.name, path.relative_to(root)).as_posix())
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = epoch
            info.mode = 0o755 if path.is_dir() or os.access(path, os.X_OK) else 0o644
            if path.is_file():
                with open(path, "rb") as handle:
                    tar.addfile(info, handle)
            else:
                tar.addfile(info)
    with open(destination, "wb") as out:
        with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=epoch, compresslevel=9) as gz:
            gz.write(raw.getvalue())
    return destination


def stage_desktop(root, target, codex_cache):
    """Sidecars and resources for apps/desktop (all git-ignored)."""
    binaries = DESKTOP / "binaries"
    binaries.mkdir(exist_ok=True)
    server = root / "bin" / exe("orkestr-v2-server", target)
    sidecar = binaries / (f"orkestr-v2-server-{target}" + (".exe" if "windows" in target else ""))
    shutil.copy2(server, sidecar)
    sidecar.chmod(0o755)
    fetch_codex.fetch(target, binaries, cache_dir=codex_cache)
    resources = DESKTOP / "resources"
    if (resources / "ui").exists():
        shutil.rmtree(resources / "ui")
    resources.mkdir(exist_ok=True)
    shutil.copytree(root / "ui", resources / "ui")
    shutil.copy2(root / "manifest.json", resources / "bundle-manifest.json")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="empty or new output directory")
    parser.add_argument("--target", help="Rust target triple (default: host)")
    parser.add_argument("--offline", action="store_true", help="pass --offline to Cargo")
    parser.add_argument("--server-bin", help="use an already built server instead of building")
    parser.add_argument("--ui-dist", help="use an already built UI bundle instead of building")
    parser.add_argument("--desktop", action="store_true", help="also stage Tauri sidecars and resources")
    parser.add_argument("--codex-cache", help="download cache for the Codex archive")
    args = parser.parse_args(argv)
    target = args.target or host_target()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    target_dir = Path(os.environ.get("CARGO_TARGET_DIR", WORKSPACE / "target")).resolve()
    try:
        server = Path(args.server_bin) if args.server_bin else build_server(target, args.offline, target_dir)
        if args.ui_dist:
            ui = Path(args.ui_dist)
        else:
            ui = out / "ui-build"
            if ui.exists():
                shutil.rmtree(ui)
            build_ui(ui, target_dir)
        root = stage(server, ui, out, workspace_version(), target)
        tarball = archive(root, source_epoch())
        if args.desktop:
            stage_desktop(root, target, args.codex_cache)
    except (BundleError, OSError, subprocess.CalledProcessError, fetch_codex.FetchError) as error:
        print(f"build_bundle: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"bundle": str(root), "archive": str(tarball), "sha256": digest(tarball)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
