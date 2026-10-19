"""Synthetic tests; opt-in --private-mount-probe uses sudo/unshare in a private NS."""

from contextlib import contextmanager
from pathlib import Path, PurePosixPath
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import path_identity as identity


def escaped(path):
    return str(path).replace("\\", r"\134").replace(" ", r"\040").replace("\t", r"\011").replace("\n", r"\012")


def mount(identifier=1, parent=0, device="8:1", root="/", point="/", filesystem="ext4"):
    return f"{identifier} {parent} {device} {escaped(root)} {escaped(point)} rw,relatime - {filesystem} synthetic rw\n"


class MountTopologyTests(unittest.TestCase):
    def test_filesystem_root_plus_relative_path(self):
        table = identity.MountTable(mount() + mount(2, 1, root="/protected/data", point="/alias"))
        view = table.filesystem_path("/alias/new")
        self.assertEqual(view.device, (8, 1))
        self.assertEqual(view.path, PurePosixPath("/protected/data/new"))

    def test_longest_visible_mount_wins(self):
        table = identity.MountTable(mount() + mount(2, 1, root="/source", point="/alias")
                                    + mount(3, 2, root="/deep", point="/alias/sub"))
        self.assertEqual(table.filesystem_path("/alias/sub/new").path, PurePosixPath("/deep/new"))
        self.assertEqual(table.filesystem_path("/alias/other").path, PurePosixPath("/source/other"))

    def test_hidden_child_does_not_win_lexical_longest_prefix(self):
        table = identity.MountTable(mount() + mount(2, 1, root="/old", point="/covered/deep")
                                    + mount(3, 1, root="/new", point="/covered"))
        self.assertEqual(table.filesystem_path("/covered/deep/file").path, PurePosixPath("/new/deep/file"))
        self.assertNotIn(identity.FilesystemPath((8, 1), PurePosixPath("/old")), table.visible_views("/covered"))

    def test_stacked_mount_uses_parentage_not_highest_id(self):
        table = identity.MountTable(mount() + mount(90, 1, root="/old", point="/stack")
                                    + mount(2, 90, root="/top", point="/stack"))
        self.assertEqual(table.filesystem_path("/stack/file").path, PurePosixPath("/top/file"))

    def test_ambiguous_stacked_siblings_are_unverifiable(self):
        table = identity.MountTable(mount() + mount(2, 1, root="/one", point="/stack")
                                    + mount(3, 1, root="/two", point="/stack"))
        with self.assertRaisesRegex(identity.PathIdentityError, "ambiguous"):
            table.filesystem_path("/stack/file")

    def test_root_mount_stack(self):
        table = identity.MountTable(mount() + mount(2, 1, device="8:2", root="/subroot", point="/"))
        self.assertEqual(table.filesystem_path("/file"), identity.FilesystemPath((8, 2), PurePosixPath("/subroot/file")))

    def test_escaped_space_tab_newline_and_backslash(self):
        for character in (" ", "\t", "\n", "\\"):
            with self.subTest(character=repr(character)):
                root, point = f"/source{character}name", f"/alias{character}name"
                table = identity.MountTable(mount() + mount(2, 1, root=root, point=point))
                self.assertEqual(table.filesystem_path(point + "/child").path, PurePosixPath(root + "/child"))

    def test_escaped_backslash_is_not_decoded_twice(self):
        table = identity.MountTable(mount() + mount(2, 1, root=r"/literal\040", point="/alias"))
        self.assertEqual(table.filesystem_path("/alias/file").path, PurePosixPath(r"/literal\040/file"))

    def test_separate_devices_with_same_root_stay_distinct(self):
        table = identity.MountTable(mount() + mount(2, 1, device="8:2", point="/other", filesystem="xfs"))
        self.assertNotEqual(table.filesystem_path("/file").device, table.filesystem_path("/other/file").device)

    def test_unrelated_nsfs_opaque_root_does_not_block_regular_path(self):
        table = identity.MountTable(mount() + mount(2, 1, device="0:4", root="net:[12345]",
                                                   point="/namespaces/test", filesystem="nsfs"))
        self.assertEqual(table.filesystem_path("/ordinary").path, PurePosixPath("/ordinary"))
        with self.assertRaisesRegex(identity.PathIdentityError, "unsupported"):
            table.filesystem_path("/namespaces/test")

    def test_unverified_filesystems_fail_closed(self):
        for filesystem in ("overlay", "nfs", "fuse.synthetic", "btrfs", "unknown"):
            with self.subTest(filesystem=filesystem), self.assertRaisesRegex(identity.PathIdentityError, "unsupported"):
                identity.MountTable(mount(filesystem=filesystem)).filesystem_path("/file")

    def test_malformed_or_incomplete_mountinfo_is_rejected(self):
        cases = ["", "not mountinfo", mount().replace("8:1", "bad"), mount() + mount(),
                 mount().replace("/ / rw", "relative / rw"), mount().replace("rw,relatime -", "-"),
                 mount() + mount(2, 99, point="/orphan"),
                 mount() + mount(2, 3, point="/cycle") + mount(3, 2, point="/cycle"),
                 mount() + mount(2, 1, point="/parent") + mount(3, 2, point="/outside"),
                 mount().replace("/ / rw", r"/\999 / rw"), mount().replace("/ / rw", r"/\123 / rw"),
                 mount().replace("1 0", "0 0"), mount(point="/not-root")]
        for text in cases:
            with self.subTest(text=text), self.assertRaises(identity.PathIdentityError):
                identity.MountTable(text)


class PathGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="v2-path-identity-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.protected = self.root / "protected"
        self.protected.mkdir()
        (self.protected / "descendant").mkdir()
        self.alias = self.root / "alias"
        self.alias.mkdir()
        device = self.root.stat().st_dev
        self.device = f"{os.major(device)}:{os.minor(device)}"
        self.base = mount(device=self.device)

    def guard(self, candidate, protected=None, extra=""):
        table = identity.MountTable(self.base + extra)
        with patch.object(identity, "read_mountinfo", return_value=table):
            return identity.assert_disjoint(candidate, protected or [self.protected])

    def bind(self, root, point=None, identifier=2, parent=1):
        return mount(identifier, parent, self.device, root, point or self.alias)

    def test_ordinary_siblings_on_same_filesystem_are_allowed(self):
        candidate = self.root / "new"
        self.assertEqual(self.guard(candidate), candidate)
        self.assertFalse(candidate.exists())

    def test_nonexistent_siblings_sharing_same_stat_anchor_are_allowed(self):
        candidate = self.root / "future-a"
        self.assertEqual(self.guard(candidate, [self.root / "future-b"]), candidate)

    def test_nesting_in_both_directions_and_equality_is_rejected(self):
        for candidate in (self.protected, self.protected / "fresh", self.root):
            with self.subTest(candidate=candidate), self.assertRaises(identity.PathOverlapError):
                self.guard(candidate)

    def test_symlink_alias_is_rejected(self):
        alias = self.root / "symlink"
        alias.symlink_to(self.protected / "descendant", target_is_directory=True)
        with self.assertRaises(identity.PathOverlapError):
            self.guard(alias / "new")

    def test_absent_leaf_under_bind_alias_to_protected_descendant_is_rejected(self):
        with self.assertRaisesRegex(identity.PathOverlapError, "mount identity"):
            self.guard(self.alias / "new", extra=self.bind(self.protected / "descendant"))

    def test_parent_and_root_binds_are_rejected(self):
        for source in (self.root, Path("/")):
            candidate = self.alias / self.protected.relative_to(source) / "new"
            with self.subTest(source=source), self.assertRaises(identity.PathOverlapError):
                self.guard(candidate, extra=self.bind(source))

    def test_alias_to_unrelated_sibling_is_allowed(self):
        other = self.root / "other"
        other.mkdir()
        candidate = self.alias / "new"
        self.assertEqual(self.guard(candidate, extra=self.bind(other)), candidate)

    def test_bind_inside_protected_tree_is_included(self):
        source = self.root / "source"
        source.mkdir()
        nested = self.protected / "mounted"
        nested.mkdir()
        with self.assertRaises(identity.PathOverlapError):
            self.guard(source / "new", extra=self.bind(source, nested))

    def test_nested_protected_mount_on_separate_device_is_included(self):
        source = self.root / "source"
        source.mkdir()
        nested = self.protected / "mounted"
        nested.mkdir()
        extra = mount(2, 1, "77:3", "/", source, "tmpfs") + mount(3, 1, "77:3", "/", nested, "tmpfs")
        with patch.object(identity, "stat_anchor", side_effect=[((1, 10), PurePosixPath("new")),
                                                                ((1, 20), PurePosixPath("."))]):
            with self.assertRaises(identity.PathOverlapError):
                self.guard(source / "new", extra=extra)

    def test_disjoint_same_relative_names_on_separate_devices_are_allowed(self):
        other = self.root / "other"
        other.mkdir()
        extra = mount(2, 1, "77:3", "/", other, "tmpfs")
        with patch.object(identity, "stat_anchor", side_effect=[((1, 10), PurePosixPath("new")),
                                                                ((2, 20), PurePosixPath("."))]):
            self.assertEqual(self.guard(other / "new", extra=extra), other / "new")

    def test_existing_hardlinked_endpoints_are_rejected(self):
        protected_file = self.protected / "data"
        protected_file.write_text("synthetic data only")
        candidate = self.root / "hardlink"
        os.link(protected_file, candidate)
        with self.assertRaisesRegex(identity.PathOverlapError, "inode"):
            self.guard(candidate, [protected_file])

    def test_stat_and_mountinfo_device_mismatch_is_unverifiable(self):
        table = identity.MountTable(mount(device="987:654"))
        with patch.object(identity, "read_mountinfo", return_value=table):
            with self.assertRaisesRegex(identity.PathIdentityError, "stat disagree"):
                identity.assert_disjoint(self.root / "new", [self.protected])

    def test_unreadable_mountinfo_does_not_fall_back_to_lexical_paths(self):
        fake = Mock()
        fake.open.side_effect = PermissionError("synthetic")
        with patch.object(identity, "MOUNTINFO", fake), self.assertRaisesRegex(identity.PathIdentityError, "unavailable"):
            identity.assert_disjoint(self.root / "new", [self.protected])

    def test_mount_change_during_validation_is_refused(self):
        first = identity.MountTable(self.base)
        second = identity.MountTable(self.base + self.bind(self.root / "other"))
        with patch.object(identity, "read_mountinfo", side_effect=[first, second]):
            with self.assertRaisesRegex(identity.PathIdentityError, "topology changed"):
                identity.assert_disjoint(self.root / "new", [self.protected])

    def test_relative_and_empty_protection_and_nonlinux_refused(self):
        with self.assertRaisesRegex(identity.PathIdentityError, "absolute"):
            identity.assert_disjoint("relative", [self.protected])
        with self.assertRaisesRegex(identity.PathIdentityError, "nonempty"):
            identity.assert_disjoint(self.root / "new", [])
        with patch.object(identity.sys, "platform", "darwin"), self.assertRaisesRegex(identity.PathIdentityError, "unsupported"):
            identity.assert_disjoint(self.root / "new", [self.protected])


def private_mount_child(root, parent_namespace):
    """No mount command is reachable before namespace and private propagation checks."""
    root = Path(root)
    if (os.readlink("/proc/self/ns/mnt") == parent_namespace or root.resolve() != root
            or not root.is_dir() or root.stat().st_mode & 0o777 != 0o700
            or (root / "probe.marker").read_text() != "synthetic-private-bind-probe"):
        raise RuntimeError("private synthetic namespace precondition failed")
    raw = Path("/proc/self/mountinfo").read_text()
    for line in raw.splitlines():
        fields = line.split()
        if any(field.startswith(("shared:", "master:")) for field in fields[6:fields.index("-")]):
            raise RuntimeError("mount propagation is not private")
    protected, alias, other = root / "protected space", root / "alias", root / "other"
    checks = []

    @contextmanager
    def bound(source, destination):
        subprocess.run(["/usr/bin/mount", "--bind", str(source), str(destination)], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        try:
            yield
        finally:
            subprocess.run(["/usr/bin/umount", str(destination)], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)

    def refused(candidate, label):
        try:
            identity.assert_disjoint(candidate, [protected])
        except identity.PathOverlapError:
            checks.append(label)
        else:
            raise AssertionError("real bind alias was accepted")

    identity.assert_disjoint(other / "new", [protected])
    checks.append("disjoint sibling accepted")
    with bound(protected / "descendant", alias):
        refused(alias / "new", "bind descendant rejected")
        with bound(other, alias):
            identity.assert_disjoint(alias / "new", [protected])
            checks.append("stacked unrelated top mount accepted")
    with bound(root, alias):
        refused(alias / protected.relative_to(root) / "new", "parent bind rejected")
    with bound(Path("/"), alias):
        refused(alias / protected.relative_to("/") / "new", "filesystem root bind rejected")
    with bound(other, protected / "mounted"):
        refused(other / "new", "nested protected bind rejected")
    with bound(protected / "descendant", alias / "deep"):
        with bound(other, alias):
            identity.assert_disjoint(alias / "deep" / "new", [protected])
            checks.append("hidden child mount does not override visible parent")
    print(json.dumps({"status": "passed", "checks": checks,
                      "private_mount_namespace": True}), flush=True)


def private_mount_probe():
    """Parent owns temporary directories; only the isolated child may mount them."""
    parent_namespace = os.readlink("/proc/self/ns/mnt")
    with tempfile.TemporaryDirectory(prefix="v2-private-bind-probe-") as directory:
        root = Path(directory).resolve()
        for relative in ("protected space/descendant", "protected space/mounted", "alias/deep", "other/deep"):
            (root / relative).mkdir(parents=True, mode=0o700)
        (root / "probe.marker").write_text("synthetic-private-bind-probe")
        alias_identity = (root / "alias").stat()
        command = (["sudo", "-n"] if os.getuid() else []) + [
            "unshare", "--mount", "--propagation", "private", sys.executable, "-B",
            str(Path(__file__).resolve()), "--private-mount-child", str(root), parent_namespace,
        ]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if result.returncode:
            raise RuntimeError("private mount probe unavailable or failed; no passing evidence")
        after = (root / "alias").stat()
        if (os.readlink("/proc/self/ns/mnt") != parent_namespace
                or (after.st_dev, after.st_ino) != (alias_identity.st_dev, alias_identity.st_ino)):
            raise RuntimeError("parent namespace or fixture identity changed")
        evidence = json.loads(result.stdout)
        if evidence.get("status") != "passed" or len(evidence.get("checks", [])) != 7:
            raise RuntimeError("incomplete private mount probe")
        evidence["parent_namespace_unchanged"] = True
        print(json.dumps(evidence, sort_keys=True))


if __name__ == "__main__":
    if sys.argv[1:] == ["--private-mount-probe"]:
        private_mount_probe()
    elif len(sys.argv) == 4 and sys.argv[1] == "--private-mount-child":
        private_mount_child(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
