"""The same selected read-only account and bounded isolation, explicit service role."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from codex_bounded.configuration import HELPERS
from codex_bounded.trust import protected
from isolation.authenticated import SelectedCodexProfile
from isolation import policy
from .contract import require


class Configuration:
    def __init__(self, package, role="deep"):
        self.package = package
        require(role in package.role_profiles, "unconfigured_role")
        self.role = role
        self.profile = SelectedCodexProfile(package.role_profiles[role])
        self.workspace_descriptor = None
        self.workspace = self.profile.workspace
        self.issued = False
        access = package.beta.get("host_full_access")
        # Operator instance opt-in: run the pinned native directly on the host
        # with the real executor environment (V1-equivalent, host-root equivalent).
        self.host_full_access = type(access) is dict and access.get("providers", True) is True
        self.host_environment = dict(access["environment"]) if self.host_full_access else None
        self.host_environment_files = list(access.get("environment_files", [])) if self.host_full_access else []
        # Host natives run real commands: a CommandExecution item/completed
        # carries the full aggregated output and can exceed the 64 KiB default.
        # Only the provider source is raised (transport bounds it at 16 MiB);
        # such tool items are parsed and dropped, never forwarded.
        if self.host_full_access:
            self.max_provider_frame = HOST_PROVIDER_FRAME

    def isolated_command(self):
        require(not self.issued, "isolated_command_already_issued")
        self.issued = True
        if self.host_full_access:
            if self.role == "fast":
                home = self.prepare_fast_home()
                return host_command(self.profile.native, self.host_environment,
                                    self.host_environment_files, fast_host_options(),
                                    {"CODEX_HOME": str(home)}), ()
            return host_command(self.profile.native, self.host_environment,
                                self.host_environment_files), ()
        descriptor = policy.filter_fd(allow_inet=True)
        try:
            command = self.profile._command(descriptor, "codex-bounded")
            mounts = []
            for name in HELPERS:
                path = protected(self.package.root / "isolation" / name)
                mounts += ["--ro-bind", str(path), "/opt/provider/" + name]
            command[command.index("--chdir"):command.index("--chdir")] = mounts
            return command, (descriptor,)
        except BaseException:
            os.close(descriptor)
            raise


    def prepare_fast_home(self):
        """Host Fast's own CODEX_HOME; the operator's home is never used."""
        require(self.host_full_access and self.role == "fast", "fast_home_role")
        operator = host_codex_home(self.host_environment)
        home = fast_home(self.profile, self.host_environment)
        state = Path(getattr(self.profile, "state_root"))
        # Never inside a checked native state root (private_state refuses any
        # unknown entry there) and never inside the operator's Codex home.
        for other in (state, operator):
            require(home != other and other not in home.parents and home not in other.parents,
                    "fast_home_scope_overlap")
        return prepare_fast_home(home, operator / "auth.json")

    def host_resume(self, native):
        """Host mode reads native threads from the real CODEX_HOME, but a thread
        Core already bound may have been created by the sandboxed provider in
        this role's private native state. Make exactly that rollout visible
        before resume; Codex otherwise refuses with `no rollout found`."""
        require(self.host_full_access, "host_full_access_required")
        state = getattr(self.profile, "state_root", None)
        require(state is not None, "host_resume_state_root")
        if self.role == "fast":
            # Fast threads started before Fast had its own home live in the
            # operator's home; later ones are already in the Fast home.
            home = self.prepare_fast_home()
            result = import_rollout(host_codex_home(self.host_environment), home, native)
            return result if result != "absent" else import_rollout(Path(state), home, native)
        return import_rollout(Path(state), host_codex_home(self.host_environment), native)


HOST_PROVIDER_FRAME = 16 * 1024 * 1024
ROLLOUT_DATE = re.compile(r"[0-9]{4}/[0-9]{2}/[0-9]{2}")
NATIVE_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def host_codex_home(environment):
    """The Codex home the host native uses: CODEX_HOME, else $HOME/.codex."""
    home = environment.get("CODEX_HOME") or str(Path(environment["HOME"]) / ".codex")
    path = Path(home)
    require(path.is_absolute() and ".." not in path.parts, "host_codex_home")
    return path


def _rollouts(root, native):
    """Rollout files for one native thread under <root>/sessions/YYYY/MM/DD."""
    sessions = root / "sessions"
    if not sessions.is_dir():
        return []
    found = []
    for path in sessions.glob(f"*/*/*/rollout-*-{native}.jsonl"):
        relative = path.relative_to(sessions)
        require(ROLLOUT_DATE.fullmatch(str(relative.parent)) is not None, "rollout_layout")
        found.append(path)
    return found


def import_rollout(state_root, codex_home, native):
    """Copy one role-private rollout into the host Codex home if it is absent.

    Returns "present", "imported" or "absent". Never overwrites, never follows
    a symlink, and copies only a regular file owned by this executor.
    """
    require(type(native) is str and NATIVE_ID.fullmatch(native) is not None, "native_identity")
    if _rollouts(codex_home, native):
        return "present"
    sources = _rollouts(state_root, native)
    if not sources:
        return "absent"  # Resume then fails exactly as before; never create.
    require(len(sources) == 1, "rollout_ambiguous")
    source = sources[0]
    info = source.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid(), "rollout_source")
    relative = source.relative_to(state_root / "sessions")
    directory = codex_home / "sessions" / relative.parent
    # Host mode is the operator's own home: Codex itself follows its layout.
    os.makedirs(directory, mode=0o700, exist_ok=True)
    target = directory / relative.name
    temporary = directory / f".{relative.name}.{os.getpid()}.import"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
    reader = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        require(os.fstat(reader).st_ino == info.st_ino, "rollout_source")
        writer = os.open(temporary, flags, 0o600)
        try:
            while True:
                chunk = os.read(reader, 1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    view = view[os.write(writer, view):]
            os.fsync(writer)
        finally:
            os.close(writer)
        try:
            os.link(temporary, target)  # Fails if a concurrent import won.
        except FileExistsError:
            pass
    finally:
        os.close(reader)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return "imported"


# Fast is read-only (protocol.FAST_SANDBOX). The sandbox covers commands and
# file edits only, so the host Fast native also loses every tool family that
# acts outside it: ChatGPT apps/connectors (e.g. cross-thread messaging),
# plugins, browser and desktop control, sub-agents, memory and goal writes,
# dependency installs and worktrees. Names are this pinned native's features;
# an unknown name makes the native refuse to start (fail closed).
# Re-verify on every native upgrade (see README "Codex native upgrade"): the
# test suite fails until this matches packaging/desktop/codex-pins.json.
FAST_FEATURES_VERIFIED_FOR = "0.163.0"
FAST_DISABLED_FEATURES = (
    "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "computer_use", "in_app_browser",
    "in_app_local_automation", "multi_agent", "multi_agent_v2", "memories", "goals",
    "worktrees", "workspace_dependencies", "skill_mcp_dependency_install",
    "image_generation", "hooks",
)
# Thread defaults for Fast. Core sends the owner's Fast model/effort (else these
# same defaults) on every turn; this keeps a Fast native from ever falling back
# to the operator's global Codex default (a Deep-class model at high effort).
FAST_DEFAULT_MODEL = "gpt-6-luna"
FAST_DEFAULT_EFFORT = "low"


def fast_host_options():
    """App-server options for a host Fast native: Fast thread defaults and every
    side-effect feature disabled. Config, rules and hooks are excluded by the
    Fast-only CODEX_HOME (`prepare_fast_home`), not by this list."""
    options = ["-c", f'model="{FAST_DEFAULT_MODEL}"',
               "-c", f'model_reasoning_effort="{FAST_DEFAULT_EFFORT}"']
    for feature in FAST_DISABLED_FEATURES:
        options += ["--disable", feature]
    return tuple(options)


# A Fast CODEX_HOME never holds operator configuration. Codex reads these from
# its home: config (MCP servers, project trust, profiles), exec-policy rules
# (an `allow` rule runs a command outside the sandbox), hooks and instructions.
# Codex itself may write some of them; they are removed before every launch.
FAST_HOME_FORBIDDEN = ("config.toml", "managed_config.toml", "rules", "hooks.json",
                       "hooks", "AGENTS.md", "AGENTS.override.md", "plugins")
# System and managed layers Codex also reads, outside any CODEX_HOME.
SYSTEM_CODEX = Path("/etc/codex")
ALLOW_RULE = re.compile(rb"""decision\s*=\s*["']allow["']""")


FAST_HOME_ROOT = Path(".local/state/orkestr-v2")


def fast_home(profile, environment):
    """The Fast role's private Codex home: OUTSIDE its native state root, which
    `isolation.authenticated.private_state` checks against a closed inventory,
    in the service user's own home (always creatable by this broker), one per
    Fast state root."""
    state = getattr(profile, "state_root", None)
    require(state is not None, "fast_home_state_root")
    home = Path(environment["HOME"])
    require(home.is_absolute() and ".." not in home.parts, "fast_home")
    key = hashlib.sha256(str(Path(state)).encode()).hexdigest()[:16]
    return home / FAST_HOME_ROOT / f"fast-codex-home-{key}"


def _private_directory(path):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) & 0o077 == 0, "fast_home")


AUTH_LIMIT = 1024 * 1024


def _read_private(path):
    """(content, stat) of a regular file, opened without following a link."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_size <= AUTH_LIMIT, "fast_auth_file")
        data = b""
        while chunk := os.read(descriptor, AUTH_LIMIT + 1 - len(data)):
            data += chunk
            require(len(data) <= AUTH_LIMIT, "fast_auth_file")
        return data, info
    finally:
        os.close(descriptor)


def _valid_auth(data):
    """Only a complete JSON object is ever propagated. Codex rewrites auth.json
    in place (truncate, then write), so a reader can catch it half written."""
    try:
        return isinstance(json.loads(data), dict)
    except ValueError:
        return False


def _unchanged(path, info):
    try:
        now = os.lstat(path)
    except FileNotFoundError:
        return False
    return (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns) == (
        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _write_private(target, data, mtime_ns, expected=None):
    """Atomic, durable 0600 replace of `target` with `data`, keeping `mtime_ns`.
    With `expected`, the target is replaced only while it is still that file,
    so a token another process wrote meanwhile is never clobbered."""
    temporary = target.parent / f".{target.name}.{os.getpid()}.sync"
    if os.path.lexists(temporary):
        os.unlink(temporary)  # Left by a crashed launch that had this pid.
    try:
        writer = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                         | os.O_CLOEXEC, 0o600)
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(writer, view):]
            os.fsync(writer)
        finally:
            os.close(writer)
        os.utime(temporary, ns=(mtime_ns, mtime_ns))
        if expected is not None and not _unchanged(target, expected):
            return False
        os.replace(temporary, target)
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return True
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def _sync_fast_auth_once(source, copy):
    data, info = _read_private(source)
    # A partial or corrupt operator file is never copied; this launch waits.
    require(_valid_auth(data), "fast_auth_source")
    if os.path.lexists(copy) and not stat.S_ISREG(os.lstat(copy).st_mode):
        os.unlink(copy)  # A link or anything else is never followed.
    if not os.path.lexists(copy):
        return _write_private(copy, data, info.st_mtime_ns) and "copied"
    current_data, current = _read_private(copy)
    if current_data == data:
        if stat.S_IMODE(current.st_mode) == 0o600:
            return "current"
        return _write_private(copy, data, info.st_mtime_ns, current) and "current"
    # Ties go to the operator file. A copy caught half written is never written back.
    if current.st_mtime_ns > info.st_mtime_ns and _valid_auth(current_data):
        return _write_private(source, current_data, current.st_mtime_ns, info) and "written_back"
    return _write_private(copy, data, info.st_mtime_ns, current) and "refreshed"


def sync_fast_auth(source, copy):
    """Keep one credential for Deep and Fast. The Fast home holds a private
    0600 copy (never a link). Before every launch the newer side wins: a
    newer operator file (Deep or the owner refreshed it) replaces the copy; a
    copy Fast's native refreshed since the last sync is written back, so a
    rotated refresh token is never lost. Equal content is left alone. Neither
    file is replaced if it changed after it was read (the sync is retried),
    and only a complete JSON object is ever propagated."""
    source, copy = Path(source), Path(copy)
    for _ in range(3):
        result = _sync_fast_auth_once(source, copy)
        if result:
            return result
    require(False, "fast_auth_busy")


def prepare_fast_home(home, auth, system=SYSTEM_CODEX):
    """Make `home` a Fast-only CODEX_HOME: private, holding only a private copy
    of the operator's auth file (`sync_fast_auth`) plus Codex's own state.
    With no config.toml no project is trusted, so project `.codex` config,
    rules and hooks stay disabled too. Refuses to launch when an `allow`
    exec-policy rule or an operator config layer could still reach Fast."""
    home = Path(home)
    auth = Path(auth)
    require(home.is_absolute() and auth.is_absolute(), "fast_home")
    for parent in reversed(home.parents):
        if not parent.exists():
            _private_directory(parent)
    # The directory holding the Fast home must be ours and not writable by others.
    parent = os.lstat(home.parent)
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid()
            and parent.st_mode & 0o022 == 0, "fast_home_parent")
    _private_directory(home)
    for name in FAST_HOME_FORBIDDEN:
        path = home / name
        if path.is_dir() and not path.is_symlink():
            import shutil
            shutil.rmtree(path)
        elif os.path.lexists(path):
            os.unlink(path)
    sync_fast_auth(auth, home / "auth.json")
    require(not reachable_allow_rules(home, system), "fast_allow_rules")
    require(not any((system / name).exists() for name in ("config.toml", "managed_config.toml",
                                                          "hooks.json")), "fast_system_config")
    return home


def reachable_allow_rules(home, system=SYSTEM_CODEX):
    """Exec-policy rule files with an `allow` decision Fast's native would load."""
    found = []
    for root in (Path(home) / "rules", Path(system) / "rules"):
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file() and ALLOW_RULE.search(path.read_bytes()):
                found.append(path)
    return found


def host_command(native, environment, environment_files=(), options=(), pinned=None):
    """No namespace, seccomp, egress proxy or mounts: `env -i` installs exactly
    the operator's real executor environment before the pinned native.

    Private environment files (for example a tool account's credentials) are
    sourced by a POSIX shell just before `exec`, so their values never appear
    in any argv. Each must be a regular file owned by this service user and
    readable by it only."""
    require(type(environment) is dict and {"HOME", "PATH"} <= set(environment) and all(
        type(k) is str and type(v) is str and k and "=" not in k and "\0" not in k + v
        for k, v in environment.items()), "host_environment")
    files = [private_environment_file(path) for path in environment_files]
    command = ["/usr/bin/env", "-i", *(f"{k}={v}" for k, v in sorted(environment.items()))]
    if files:
        script = 'set -a; for f in ' + " ".join('"$%d"' % (i + 1) for i in range(len(files))) + \
            '; do . "$f"; done; set +a; shift %d; exec "$@"' % len(files)
        command += ["/bin/sh", "-c", script, "orkestr-host-env", *files]
    require(all(type(option) is str and "\0" not in option for option in options), "host_options")
    # Pinned values are set last, after any environment file, so a sourced
    # file cannot override them (e.g. Fast's CODEX_HOME).
    pinned = dict(pinned or {})
    require(all(type(k) is str and type(v) is str and k and "=" not in k and "\0" not in k + v
                for k, v in pinned.items()), "host_pinned_environment")
    if pinned:
        command += ["/usr/bin/env", *(f"{k}={v}" for k, v in sorted(pinned.items()))]
    return command + [str(native), "app-server", *options, "--listen", "stdio://"]


def private_environment_file(path):
    """Operator env file: absolute, regular, owned by us, mode 0600 or stricter."""
    require(type(path) is str and path.startswith("/") and "\0" not in path
            and ".." not in Path(path).parts, "host_environment_file")
    info = os.stat(path, follow_symlinks=False)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) & 0o077 == 0 and info.st_size <= 65536,
            "host_environment_file")
    return path
