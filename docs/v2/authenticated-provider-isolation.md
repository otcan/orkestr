# Opt-in selected-account Codex isolation

`isolation.authenticated.SelectedCodexProfile` is a concrete trusted-connector
profile, separate from the offline untrusted Worker-tool boundary. It is not
registered or enabled by default. No authenticated provider has been launched.

Root stages an immutable private JSON file, an immutable supervisor and fixed
launcher wrapper. The JSON has exactly these fields (all examples are synthetic):

```json
{
  "format": "orkestr-v2-codex-isolated-v1",
  "native": "/opt/example/provider/native",
  "auth_file": "/srv/example/canonical-codex/auth.json",
  "sessions": "/srv/example/role-state/sessions",
  "workspace": "/srv/example/role-workspace",
  "egress_socket": "/run/example-provider/egress.sock",
  "supervisor": "/opt/example/provider/supervisor.py",
  "hosts": ["subscription.example.invalid"]
}
```

The private manifest and all its ancestors must be root-owned and not group/world
writable. Native must be a canonical root-owned ELF. Supervisor is root-owned and
executable. Root selects the existing canonical Codex auth file; it must not create
another login. Only this single file is mounted read-only at `/account/auth.json`;
no home, parent account directory, config, overlays or unrelated projects enter.
Auth contents are neither read nor copied by the launcher. Auth rotation/refresh
that needs writes is unsupported and must fail rather than fall back to host home.
The selected sessions directory alone is writable/persistent, at
`/account/sessions`. Selected workspace is mounted read-only at its exact canonical
path so Runtime's native cwd checks remain meaningful. These paths must be private,
canonical, owned by root or the current managed UID, with no writable ancestors
outside that ownership. Root must choose role-specific state, never V1 threads.

A root-staged wrapper calls `launcher_main(fixed_private_configuration_path)`.
It accepts only `app-server --listen stdio://`, executes the namespace profile in
place, and preserves the broker's owned stdin/stdout pipes. It has no client
path/account/env/command selectors. Root must explicitly configure this wrapper
as the isolated provider launch entry and retain native ELF provenance separately.
It is not interchangeable with an unreviewed shim. No production wrapper changed.

The namespace profile preserves the managed UID and private mount/user/PID/net/
IPC/UTS/cgroup namespaces. A trusted supervisor has only a loopback CONNECT proxy
and a bind of one root-owned Unix egress socket (root-owned immutable parent,
no world permission). Native receives a fresh strict seccomp filter before exec:
only AF_INET stream sockets are possible, no AF_UNIX, fork, independent process,
namespace changes, ptrace or process-memory access. The private network namespace
has no host interface or route. There is no host-network fallback. Native receives
only fixed runtime/home/account/proxy environment, not parent secrets. Public CA
trust is mounted read-only; TLS remains end-to-end with native certificate checks.

Supervisor accepts exact allowlisted hostnames on port 443, CONNECT only, bounded
4096-byte headers, four simultaneous tunnels, 4 MiB aggregate bytes per tunnel,
and 30-second tunnel lifetimes. Caller headers are stripped. This deliberately
bounded initial profile may refuse longer sessions; it does not claim full-release
limits. Native cannot directly access the Unix endpoint. The supervisor handles
network bytes, not inference capabilities or durable authority.

Root must provision the Unix service before activation. `isolation.egress` provides
`serve_connection(accepted_unix_socket, exact_hosts)` as its per-connection handler.
Root owns socket creation, group access, bounded worker pool and teardown. It
revalidates CONNECT, resolves once, rejects every answer containing any nonpublic
address (including mixed answers), then connects only a validated numeric address.
It never forwards plaintext HTTP or accepts client-selected ports. The deployment
must bound DNS resolution/service-worker lifetime independently; the supervisor
closes its connection on deadline but cannot kill a blocked host resolver thread.
No root listener, DNS request or outbound Internet connection was started here.

The immutable profile hostname list and root service list must match exactly;
actual subscription destinations need independent root review. No wildcard,
API-key billing fallback, custom CA or proxy override is supported. This checkpoint
is Codex-only. Managed Claude token injection requires a separate reviewed profile;
it is not enabled through inherited environment or auth copies.

Runtime retains its actual provider-stdin writer and must fence each bounded
metadata/execution/control suffix with the exact Core purpose capability. The
supervisor reads native stdin only in test mode; production simply passes its read
end to native. Stdio ownership alone is not an issuer or process-reap proof.
Persistent resume requires the existing grant/native identity/retired-child gates;
this filesystem projection does not replace them. Codex's native session-index
requirements beyond the projected sessions directory remain an authenticated
compatibility gate: do not silently mount the full canonical home if it refuses.

Synthetic validation exercises actual namespaces, selected read-only account
sentinel, persistent session writes, native stdin/stdout, allowed proxy exchange,
direct external/Unix/fork refusal, and hidden unrelated host state. The synthetic
fixture bypasses root profile provisioning validation explicitly; another test
proves unprovisioned private configuration refuses before spawn. DNS policy tests
use synthetic resolver answers only. Actual authenticated launch, real destination
selection, root endpoint provisioning, ordinary HTTP integration, Stop/resume and
persistent native compatibility remain unexecuted.

The authenticated profile has a separate fixed resource budget: 600 CPU seconds,
8 GiB address space, 256 descriptors, 256 MiB file size, four tunnels, and a
15-minute/64 MiB bound per tunnel. Offline limits remain unchanged. These are
bounded compatibility defaults, not evidence that every long Deep workflow fits.
The authenticated seccomp policy permits anonymous AF_UNIX SOCK_STREAM socketpair
with protocol zero (including CLOEXEC/NONBLOCK flags) for native Tokio signals.
Named AF_UNIX socket creation, datagram/seqpacket pairs and offline socketpairs
remain refused. The selected root egress endpoint remains supervisor-only.

Private manifest v2 replaces `sessions` with `state_root`. This dedicated role
root admits only sessions/archived_sessions, session_index.jsonl, state_5.sqlite,
logs_2.sqlite and their WAL/SHM/journal companions. An empty auth.json mountpoint
is overmounted read-only with the canonical selected auth; copied auth, config,
symlinks and unrelated files refuse. Installed native strings identify these
metadata filenames; their actual persistence/resume behavior remains a native
compatibility gate. No full canonical home is mounted.

The synthetic namespace regression checks stream-pair operation, denied Unix
socket/datagram/seqpacket creation, private SQLite/index persistence, budgets,
proxy exchange and owned cleanup. Protected root-staged actual native initialize
against this revision is **unexecuted** by this lane; root owns the existing
fake-auth/disconnected-endpoint probe and must repin the full seven-file inventory.
No account read, inference or authenticated network access is authorized by this
compatibility test.

Writable-state validation rejects every regular file with link count other than
one, including nested session artifacts. Top-level sessions/archived_sessions
must be directories; database/index/auth-placeholder entries must be regular
files. Refusal tests preserve an unmounted hardlink target byte-for-byte. This
pre-bind validation still assumes a controlled canonical parent and no concurrent
replacement by a same-UID actor; it is not a race-proof filesystem authority.

## Native restart projection

The installed native's first real turn produced additional role databases:
goals_1, memories_1, queue_1 and thread_history_1 (sqlite plus WAL/SHM/journal).
These exact regular-file names now persist alongside state_5/logs_2 and sessions.
installation_id and .sandbox_migration are bounded to 4 KiB; models_cache.json
is bounded to 8 MiB. All retain the same ownership/type/single-link checks.
No arbitrary database basename, copied auth, config or symlink is admitted.

/account/tmp, /account/cache, /account/skills and /account/thread-writer-locks
are separate 32 MiB tmpfs mounts, fresh on every Codex launch. Native-generated
helper symlinks can exist there only during that namespace lifetime; they never
become accepted durable state. Skills/cache downloads do not persist between
launches. Host mountpoints must be empty directories before launch and remain
empty after namespace teardown. This is not a native-tool execution grant.

A state directory generated by the older projection containing nonempty tmp,
cache, skills or thread-writer-locks **still refuses**. After independently proving
all old processes reaped, root must quarantine those four disposable directories
outside the writable state projection and replace them with empty private
directories (or let the mount builder create empty mountpoints). Preserve the
SQLite/index/session files. This implementation never deletes/moves private
state itself, follows helper symlinks, or weakens hardlink validation. Root owns
that one-time migration and the actual-native resume rerun.

The synthetic actual-namespace two-launch regression preserves a role database
across both launches while helper symlinks/skills disappear. The unchanged-target
hardlink and legacy-nonempty refusal tests remain active. Root's prior real
sentinel is evidence for first-turn compatibility only; native resume on this
new exact source remains unexecuted by this lane.
