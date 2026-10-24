#!/usr/bin/env python3
"""Fetch the official Codex CLI binary for one target and verify its checksum.

The pinned release, URLs and SHA-256 digests live in codex-pins.json. A
download whose size or digest differs is deleted and the build fails. The
archive must hold exactly one regular file (the codex executable); it is
written as `codex-<target>[.exe]`, the Tauri sidecar naming convention.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent
CHUNK = 1 << 20


class FetchError(Exception):
    pass


def load_pins(path):
    pins = json.loads(Path(path).read_text())
    if pins.get("schema") != 1 or not isinstance(pins.get("targets"), dict):
        raise FetchError("unsupported pin file")
    return pins


def pin_for(pins, target, *, allow_file_for_tests=False):
    entry = pins["targets"].get(target)
    if entry is None:
        raise FetchError(f"no pinned Codex build for {target}")
    digest = entry.get("sha256", "")
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise FetchError("pinned digest must be 64 lowercase hex characters")
    url = str(entry.get("url", ""))
    if not url.startswith("https://") and not (allow_file_for_tests and url.startswith("file://")):
        raise FetchError("pinned URL must use https")
    return entry


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def download(entry, cache_dir):
    """Return a verified archive path, reusing a verified cached copy."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{entry['sha256']}.archive"
    if cached.is_file() and sha256_file(cached) == entry["sha256"]:
        return cached
    partial = cached.with_suffix(".partial")
    request = urllib.request.Request(entry["url"], headers={"User-Agent": "orkestr-desktop-build"})
    digest, size = hashlib.sha256(), 0
    expected = int(entry.get("size", 0))
    limit = expected or 512 * CHUNK
    with urllib.request.urlopen(request, timeout=120) as response, open(partial, "wb") as out:
        for block in iter(lambda: response.read(CHUNK), b""):
            size += len(block)
            if size > limit:
                break
            digest.update(block)
            out.write(block)
    wrong_size = size > limit or (expected and size != expected)
    if wrong_size or digest.hexdigest() != entry["sha256"]:
        partial.unlink(missing_ok=True)
        raise FetchError(f"checksum mismatch for {entry['url']}")
    partial.replace(cached)
    return cached


def extract_single(archive, destination):
    with tarfile.open(archive, "r:gz") as tar:
        members = [m for m in tar.getmembers() if not m.isdir()]
        if len(members) != 1 or not members[0].isfile():
            raise FetchError("archive must contain exactly one regular file")
        source = tar.extractfile(members[0])
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as out:
            shutil.copyfileobj(source, out)
            temporary = Path(out.name)
    temporary.chmod(0o755)
    temporary.replace(destination)


def fetch(target, out_dir, pins_path=HERE / "codex-pins.json", cache_dir=None, *, allow_file_for_tests=False):
    """Release callers require HTTPS; local test fixtures explicitly opt in."""
    pins = load_pins(pins_path)
    entry = pin_for(pins, target, allow_file_for_tests=allow_file_for_tests)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache = Path(cache_dir) if cache_dir else Path(tempfile.gettempdir()) / "orkestr-codex-cache"
    archive = download(entry, cache)
    suffix = ".exe" if "windows" in target else ""
    destination = out_dir / f"codex-{target}{suffix}"
    extract_single(archive, destination)
    return destination, pins["version"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="Rust target triple, e.g. x86_64-unknown-linux-gnu")
    parser.add_argument("--out", required=True, help="directory for codex-<target>[.exe]")
    parser.add_argument("--cache", help="download cache (default: system temp)")
    parser.add_argument("--pins", default=str(HERE / "codex-pins.json"))
    args = parser.parse_args(argv)
    try:
        path, version = fetch(args.target, args.out, args.pins, args.cache)
    except (FetchError, OSError, tarfile.TarError) as error:
        print(f"fetch_codex: {error}", file=sys.stderr)
        return 1
    print(f"codex {version} for {args.target}: {path} sha256={sha256_file(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
