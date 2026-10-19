"""Linux preflight path isolation, including bind mounts and absent destinations.

Call assert_disjoint(candidate, protected_paths) before creating/copying state.
It returns the canonical candidate or raises PathIdentityError (overlap uses the
subclass PathOverlapError). Unverifiable input never falls back to path strings.

This checks the current mount namespace, not future changes or hostile concurrent
filesystem mutation. Callers still own private-parent/permission checks, locking,
fresh-target requirements, file-by-file symlink/hardlink policy and sandboxing.
Layered/network filesystems cannot be established from mountinfo alone and are
unsupported here; so are non-Linux platforms. No process, mount or write occurs.
"""

from dataclasses import dataclass
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys


MOUNTINFO = Path("/proc/self/mountinfo")
MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024
SUPPORTED_FILESYSTEMS = frozenset({"ext2", "ext3", "ext4", "xfs", "tmpfs", "ramfs"})
ESCAPES = {"040": " ", "011": "\t", "012": "\n", "134": "\\"}


class PathIdentityError(RuntimeError):
    """Path isolation could not be verified; operation must not continue."""


class PathOverlapError(PathIdentityError):
    """Candidate overlaps a protected path through a visible filesystem view."""


def need(condition, reason):
    if not condition:
        raise PathIdentityError(reason)


def nested(left, right):
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


def decoded_path(raw, opaque=False):
    def decode(match):
        value = ESCAPES.get(match.group(1))
        need(value is not None, "unsupported mountinfo escape")
        return value

    need(not re.search(r"\\(?![0-7]{3})", raw), "malformed mountinfo escape")
    value = re.sub(r"\\([0-7]{3})", decode, raw)
    path = PurePosixPath(value)
    need((path.is_absolute() or opaque) and str(path) == value and ".." not in path.parts
         and "\0" not in value, "noncanonical mountinfo path")
    return path


@dataclass(frozen=True)
class Mount:
    identifier: int
    parent: int
    device: tuple
    root: PurePosixPath
    point: PurePosixPath
    filesystem: str


@dataclass(frozen=True)
class FilesystemPath:
    device: tuple
    path: PurePosixPath


class MountTable:
    """Visible topology, not an arbitrary longest-prefix choice among hidden mounts."""

    def __init__(self, text):
        self.mounts = self.parse(text)
        self.by_id = {mount.identifier: mount for mount in self.mounts}
        self.children = {}
        for mount in self.mounts:
            self.children.setdefault(mount.parent, []).append(mount)
        roots = [mount for mount in self.mounts if mount.point == PurePosixPath("/")
                 and (mount.parent not in self.by_id or mount.parent == mount.identifier)]
        need(len(roots) == 1, "cannot establish mount namespace root")
        self.root = roots[0]
        for mount in self.mounts:
            if mount is not self.root:
                need(mount.parent in self.by_id, "incomplete mount parent topology")
                parent = self.by_id[mount.parent]
                need(mount.point.is_relative_to(parent.point), "inconsistent mount parent path")
        for mount in self.mounts:
            visited, cursor = set(), mount
            while cursor is not self.root:
                need(cursor.identifier not in visited, "cyclic mount topology")
                visited.add(cursor.identifier)
                cursor = self.by_id[cursor.parent]

    @staticmethod
    def parse(text):
        need(isinstance(text, str) and bool(text.strip()), "mountinfo is empty")
        need(len(text.encode("utf-8", errors="surrogateescape")) <= MAX_MOUNTINFO_BYTES,
             "mountinfo exceeds supported size")
        mounts, identifiers = [], set()
        for line in text.splitlines():
            parts = line.split()
            need("-" in parts, "malformed mountinfo separator")
            separator = parts.index("-")
            need(separator >= 6 and len(parts) == separator + 4, "malformed mountinfo fields")
            need(re.fullmatch(r"[1-9][0-9]*", parts[0]) and re.fullmatch(r"[0-9]+", parts[1])
                 and re.fullmatch(r"[0-9]+:[0-9]+", parts[2]), "malformed mount identity")
            identifier, parent = int(parts[0]), int(parts[1])
            need(identifier not in identifiers, "duplicate mount identity")
            identifiers.add(identifier)
            filesystem = parts[separator + 1]
            # nsfs uses opaque roots such as net:[inode]; unrelated namespace
            # handles must not make an otherwise ordinary ext4 path unusable.
            mounts.append(Mount(identifier, parent, tuple(map(int, parts[2].split(":"))),
                                decoded_path(parts[3], opaque=filesystem == "nsfs"),
                                decoded_path(parts[4]), filesystem))
        return tuple(mounts)

    def selected(self, path):
        """Longest *visible* mountpoint: cross parent mounts before their children.

        A pre-existing child hidden by a later parent overmount must not win just
        because its lexical mountpoint is longer. Equal sibling mountpoints are
        ambiguous; mount-ID ordering is not proof of which one is on top.
        """
        path = PurePosixPath(path)
        current, visited = self.root, set()
        while True:
            need(current.identifier not in visited, "cyclic visible mount topology")
            visited.add(current.identifier)
            children = [child for child in self.children.get(current.identifier, ())
                        if child is not current and path.is_relative_to(child.point)]
            if not children:
                return current
            depth = min(len(child.point.parts) for child in children)
            next_mounts = [child for child in children if len(child.point.parts) == depth]
            need(len(next_mounts) == 1, "ambiguous stacked mount identity")
            current = next_mounts[0]

    def filesystem_path(self, path):
        path = PurePosixPath(path)
        mount = self.selected(path)
        need(mount.filesystem in SUPPORTED_FILESYSTEMS,
             "filesystem identity unsupported; isolation is unverified")
        return FilesystemPath(mount.device, mount.root / path.relative_to(mount.point))

    def visible_views(self, path):
        """Include nested mounts exposing other protected filesystem subtrees.

        A parent's backing tree is conservatively protected even where a child
        mount currently hides it; removing that mount must not expose overlap.
        """
        path = PurePosixPath(path)
        views = {self.filesystem_path(path)}
        for mount in self.mounts:
            if mount.point.is_relative_to(path) and self.selected(mount.point) == mount:
                views.add(self.filesystem_path(mount.point))
        return views


def canonical(raw):
    path = Path(raw)
    need(path.is_absolute(), "path must be absolute")
    try:
        return path.resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as error:
        raise PathIdentityError("path cannot be resolved") from error


def stat_anchor(path, table):
    """Return nearest existing inode plus suffix, never a bare common ancestor.

    Comparing only an ancestor's inode would incorrectly reject every sibling
    under that directory. The suffix keeps absent sibling destinations distinct.
    """
    anchor = path
    while True:
        try:
            info = anchor.stat()
            break
        except FileNotFoundError:
            need(anchor != anchor.parent, "no existing path anchor")
            anchor = anchor.parent
        except (OSError, ValueError) as error:
            raise PathIdentityError("path identity cannot be read") from error
    suffix = PurePosixPath(path.relative_to(anchor))
    need(anchor == path or stat.S_ISDIR(info.st_mode), "non-directory path ancestor")
    actual_device = (os.major(info.st_dev), os.minor(info.st_dev))
    need(actual_device == table.selected(anchor).device,
         "mountinfo and filesystem stat disagree; isolation is unverified")
    need(table.selected(anchor) == table.selected(path),
         "nonexistent path crosses an unverifiable mount")
    return (info.st_dev, info.st_ino), suffix


def read_mountinfo():
    try:
        with MOUNTINFO.open("r", encoding="utf-8", errors="surrogateescape") as stream:
            text = stream.read(MAX_MOUNTINFO_BYTES + 1)
        return MountTable(text)
    except (OSError, UnicodeError, ValueError) as error:
        raise PathIdentityError("mountinfo is unavailable or invalid; isolation is unverified") from error


def assert_disjoint(candidate, protected_paths):
    """Return canonical candidate if all roots are disjoint, else fail closed.

    Linux bind/root/parent aliases and visible mounts nested within protected
    roots are included. Stat identities additionally catch existing hardlinked
    endpoints. The caller must pass every protected home/source/package root.
    This is not a recursive hardlink audit of files inside existing trees.
    """
    need(sys.platform.startswith("linux"), "path identity unsupported on this platform")
    candidate = canonical(candidate)
    protected = tuple(canonical(path) for path in protected_paths)
    need(bool(protected), "protected paths must be explicit and nonempty")
    if any(nested(candidate, path) for path in protected):
        raise PathOverlapError("candidate overlaps a protected canonical path")
    table = read_mountinfo()
    candidate_anchor, candidate_suffix = stat_anchor(candidate, table)
    candidate_views = table.visible_views(candidate)
    for path in protected:
        anchor, suffix = stat_anchor(path, table)
        if candidate_anchor == anchor and nested(candidate_suffix, suffix):
            raise PathOverlapError("candidate overlaps a protected filesystem inode")
        for left in candidate_views:
            for right in table.visible_views(path):
                if left.device == right.device and nested(left.path, right.path):
                    raise PathOverlapError("candidate overlaps a protected mount identity")
    # A mount change during inspection invalidates the snapshot. This does not
    # replace exclusion/locking against subsequent hostile namespace mutations.
    need(read_mountinfo().mounts == table.mounts, "mount topology changed during path validation")
    return candidate
