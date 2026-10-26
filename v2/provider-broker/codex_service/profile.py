"""The same selected read-only account and bounded isolation, explicit service role."""
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
            options = fast_host_options(self.host_environment) if self.role == "fast" else ()
            return host_command(self.profile.native, self.host_environment,
                                self.host_environment_files, options), ()
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


    def host_resume(self, native):
        """Host mode reads native threads from the real CODEX_HOME, but a thread
        Core already bound may have been created by the sandboxed provider in
        this role's private native state. Make exactly that rollout visible
        before resume; Codex otherwise refuses with `no rollout found`."""
        require(self.host_full_access, "host_full_access_required")
        state = getattr(self.profile, "state_root", None)
        require(state is not None, "host_resume_state_root")
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
FAST_DISABLED_FEATURES = (
    "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "computer_use", "in_app_browser",
    "in_app_local_automation", "multi_agent", "multi_agent_v2", "memories", "goals",
    "worktrees", "workspace_dependencies", "skill_mcp_dependency_install",
    "image_generation",
)
MCP_SERVER_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")


def fast_host_options(environment):
    """App-server options for a host Fast native: disabled side-effect features
    and every MCP server the operator's Codex config declares, by name."""
    options = []
    for feature in FAST_DISABLED_FEATURES:
        options += ["--disable", feature]
    for name in configured_mcp_servers(host_codex_home(environment) / "config.toml"):
        options += ["-c", f"mcp_servers.{name}.enabled=false"]
    return tuple(options)


def configured_mcp_servers(path):
    """MCP server names in the operator's config.toml (none if absent). A name
    that cannot be disabled by a dotted override refuses the launch."""
    import tomllib
    try:
        with open(path, "rb") as handle:
            config = tomllib.load(handle)
    except FileNotFoundError:
        return []
    servers = config.get("mcp_servers", {})
    require(type(servers) is dict and all(type(name) is str and MCP_SERVER_NAME.fullmatch(name)
                                          for name in servers), "fast_mcp_servers")
    return sorted(servers)


def host_command(native, environment, environment_files=(), options=()):
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
