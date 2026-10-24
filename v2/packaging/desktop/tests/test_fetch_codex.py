import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_codex  # noqa: E402

TARGET = "x86_64-unknown-linux-gnu"


def archive(path, members):
    with tarfile.open(path, "w:gz") as tar:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


class FetchCodexTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fetch-codex-"))

    def pins(self, source, digest=None, size=None):
        data = source.read_bytes()
        entry = {"url": source.as_uri(), "sha256": digest or hashlib.sha256(data).hexdigest(),
                 "size": len(data) if size is None else size}
        path = self.root / "pins.json"
        path.write_text(json.dumps({"schema": 1, "version": "0.0.0-test", "targets": {TARGET: entry}}))
        return path

    def test_verified_single_binary_is_installed_with_sidecar_name(self):
        source = archive(self.root / "codex.tar.gz", [("codex-x86_64-unknown-linux-musl", b"#!/bin/sh\necho codex\n")])
        path, version = fetch_codex.fetch(TARGET, self.root / "out", self.pins(source), self.root / "cache", allow_file_for_tests=True)
        self.assertEqual(path.name, f"codex-{TARGET}")
        self.assertEqual(path.read_bytes(), b"#!/bin/sh\necho codex\n")
        self.assertTrue(path.stat().st_mode & 0o100)
        self.assertEqual(version, "0.0.0-test")
        # A second fetch reuses the verified cache entry.
        fetch_codex.fetch(TARGET, self.root / "out2", self.pins(source), self.root / "cache", allow_file_for_tests=True)

    def test_digest_or_size_mismatch_fails_and_leaves_nothing(self):
        source = archive(self.root / "codex.tar.gz", [("codex", b"payload")])
        for pins in (self.pins(source, digest="0" * 64), self.pins(source, size=3)):
            with self.assertRaises(fetch_codex.FetchError):
                fetch_codex.fetch(TARGET, self.root / "out", pins, self.root / "cache", allow_file_for_tests=True)
            self.assertFalse((self.root / "out" / f"codex-{TARGET}").exists())
            self.assertEqual(list((self.root / "cache").glob("*")), [])

    def test_archives_with_extra_or_odd_members_are_refused(self):
        source = archive(self.root / "codex.tar.gz", [("codex", b"a"), ("other", b"b")])
        with self.assertRaises(fetch_codex.FetchError):
            fetch_codex.fetch(TARGET, self.root / "out", self.pins(source), self.root / "cache", allow_file_for_tests=True)

    def test_release_fetch_refuses_local_pins_before_creating_output(self):
        source = archive(self.root / "codex.tar.gz", [("codex", b"payload")])
        with self.assertRaisesRegex(fetch_codex.FetchError, "https"):
            fetch_codex.fetch(TARGET, self.root / "out", self.pins(source), self.root / "cache")
        self.assertFalse((self.root / "out").exists())
        self.assertFalse((self.root / "cache").exists())

    def test_unpinned_targets_and_weak_pins_are_refused(self):
        pins = {"schema": 1, "version": "x", "targets": {TARGET: {"url": "http://example.invalid/a", "sha256": "0" * 64}}}
        with self.assertRaises(fetch_codex.FetchError):
            fetch_codex.pin_for(pins, "riscv64gc-unknown-linux-gnu")
        with self.assertRaises(fetch_codex.FetchError):
            fetch_codex.pin_for(pins, TARGET)
        with self.assertRaises(fetch_codex.FetchError):
            fetch_codex.pin_for(pins, TARGET, allow_file_for_tests=True)

    def test_shipped_pins_cover_every_desktop_target(self):
        pins = fetch_codex.load_pins(fetch_codex.HERE / "codex-pins.json")
        for target in ("x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"):
            entry = fetch_codex.pin_for(pins, target)
            self.assertTrue(entry["url"].startswith("https://github.com/openai/codex/releases/download/"))


if __name__ == "__main__":
    unittest.main()
