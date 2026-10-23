# Trusted owned-session provider broker

This standalone Python standard-library server is a trusted connector, separate
from untrusted workers. It opens a dedicated Codex app-server over stdio with
fixed arguments `app-server --listen stdio://`. It creates a new persistent
native thread per role/channel; it never resumes a V1 thread or connects to a
shared app-server. The separate Claude entry
(`claude_server.py`) and its installed-CLI qualification are described in
`docs/v2/claude-installed-cli.md`.

The executable accepts exactly:

```
server.py open-owned-session --protocol orkestr-v2-provider-broker-v1
```

A trusted installer supplies `broker-private.json` beside the installed server,
or an immutable launcher wrapper imports `server.main(private_configuration_path)`.
There is no client config flag, listener, socket, arbitrary command or environment
API. The public schema/example is `configuration.example.json`; do not place real
configuration or credentials in this repository. Existing canonical `CODEX_HOME`
is referenced only inside the trusted connector environment. Auth is never
copied, refreshed, returned or injected into a worker. The provider environment
contains only PATH, LANG, LC_ALL, HOME, TMPDIR and CODEX_HOME. The installed
executable, modules, configuration and their parent directories must be trusted
and immutable to clients; canonicalization is not a replacement-race defense.

## Wire contract

Each frame is one UTF-8 JSON object plus LF, at most 65,536 bytes excluding LF.
Duplicate keys, unknown command fields and nonfinite numbers are rejected.
Client request IDs are positive integers, unique across the channel (maximum
256 requests). There is one outstanding provider request, no automatic retry,
reconnect or process replacement, and at most eight queued frames per sink.
Oversize, truncated EOF, protocol failure or queue exhaustion closes the channel;
a consumed turn remains delivery-unknown and must be reconciled.

1. `OpenOwnedSession` is exactly Runtime's c84 codec: `{id,method,params}` where
   params is `{protocol,identity}` and identity contains provider, role, owner_id,
   session_id, namespace, incarnation. Only provider `codex` is accepted. The
   response is `{id,result:{protocol,identity,metadata_only:true,owned_handle}}`.
   The handle is metadata correlation, never dispatch authority.
2. `BrokerMetadata` params are exactly `{owned_handle,frame}`. The frame permits
   initialize, initialized, account/read with refreshToken=false, then thread/start
   with server-configured canonical cwd, approvalPolicy=never, sandbox=read-only,
   and explicit ephemeral=false. Unknown metadata methods (including turn/start),
   foreign paths, API-key accounts and nonpersistent readiness are refused.
3. Correlated provider replies are `{id:<outer>,result:{owned_handle,frame}}`.
   `initialized` gets frame=null. Allowed turn notifications use
   `{method:"BrokerOutput",params:{owned_handle,frame}}`. Runtime must independently
   unwrap/correlate and validate native readiness. Initialization replaces
   codexHome with `broker-private`; account output exposes only subscription type
   and requiresOpenaiAuth. Unknown provider notifications are discarded, server
   requests refused, and output fields are restricted.
4. `CommitExecution` has the same wrapper shape but permits only the cap-derived
   text-only turn/start frame. Its threadId must match this channel's new native
   thread. Only one commit is allowed, latched before provider write. No public
   metadata method forwards it. Runtime's private serializer must consume the
   real Core dispatch by value after one-way readiness attachment, and enqueue
   and flush under the actual durable execution fence. This server cannot verify
   a Core issuer capability from JSON: it TRUSTS the exclusively owned parent
   stdin pipe. Wire identity/handles alone prove no Core authority.

There is no interrupt command. A later scoped control envelope requires an issued
Core cancel receipt and durable control fence; a handle or old turn grant is
insufficient. No arbitrary SIG/PID operation is exposed.

## Process ownership and open release gates

The provider inherits the broker's Runtime-owned process group. It must not
start a new session, daemonize or detach. Runtime owns group revocation/reaping;
normal broker EOF/error also terminates and reaps its direct provider child.
No live process is adopted. This is NOT an OS sandbox. Same-UID filesystem and
`/proc` access, canonical credential-directory exposure to malicious same-UID
processes, networking, subprocess escape and host privilege separation remain
open release work. Environment clearing does not close these gaps.

Synthetic verification:

```
python3 -m unittest discover -s v2/provider-broker -p 'test_*.py' -v
python3 -m py_compile v2/provider-broker/*.py
```

Tests start only an owned fake executable in disposable directories, including
fixed argv/environment, metadata/new-thread/one-turn path, duplicate refusal and
EOF reaping. Transport backpressure/partial-write checks are mocked. No real
provider, canonical account, paid inference or host installation was executed.
Runtime wrapper integration, actual provider compatibility, independent review,
private host installation and OS isolation acceptance remain pending.

Review hardening: setup pins `modelProvider:"openai"`, requires ChatGPT account
with `requiresOpenaiAuth:true`, and preserves matching `openai` proof on the
thread/result. External, absent or mismatched provider evidence refuses readiness.
Wire input is strict UTF-8 with finite JSON numbers. Malformed nested responses
refuse without printing traceback or private paths. Source reads pause at the
existing eight-frame sink bound and resume buffered lines as writes drain; no
queue cap increase or prefix replay. Production private config must select the
canonical native Codex ELF directly, never a JS shim or symlink. Synthetic test
executables are intentionally fixtures, not installation account evidence.

Closed control extension (not yet admitted by Runtime): `CancelExecution` has the
same owned-handle envelope, with only `turn/interrupt {threadId,turnId}` inside.
Both native IDs must equal this child's active turn. One attempt is latched before
write; metadata cannot submit it, arbitrary signals/methods refuse. The parent
must submit only from a sealed control wrapper under Core's cancellation fence
using the receipt's new fenced admission and original immutable binding. The
server trusts its exclusive parent pipe, not JSON as proof of that receipt.
A further `CommitExecution` is allowed only after a terminal completed/failed/
interrupted observation and with a previously unseen durable message ID; each
requires a fresh consumed capability and current execution fence in Runtime.
Unknown/lost reply is not terminal, and never authorizes a retry or restart.

### Sole-writer handoff (required server entry)

The trusted launcher passes one connected private Unix stream socket as fd 3;
there is no listener, path or client-selectable descriptor. At native child
creation the server sends exactly `provider-stdin-v1` with one SCM_RIGHTS writer,
closes its writer and socket, and retains only provider stdout. The receiver must
reject extra/foreign descriptors, set CLOEXEC, verify nonblocking mode and bind
the opaque writer to the original local child lineage. The server never queues
or writes provider stdin in this mode. The old in-process Pump mode is only a
synthetic test facility; the executable has no fallback to it.

For each validated metadata/execution/control envelope, the server first records
its existing correlation, then emits
`{"method":"BrokerPrepared","params":{"owned_handle":"opaque","request_id":2}}`.
Only then may Runtime write the exact derived native frame directly to the
provider writer. Runtime must require preparation before setup, retain its opaque
preparation proof and byte offset, and fence **each** bounded nonblocking suffix
with the exact issued Core metadata/execution/cancellation authority. Waiting for
preparation or provider replies occurs outside SQLite. Existing BrokerOutput
correlation is unchanged. `initialized` emits preparation followed by its null
completion; Runtime must finish the actual write before accepting that completion.

Pipe enqueue/preparation is not provider delivery. Revoked authority refuses an
unwritten suffix; any partial bytes or fence commit failure is unknown delivery,
requires child quarantine, and never restores a consumed grant or retries a
possibly written prefix. Stop remains uncertain until interrupt acknowledgement
or owned-process cleanup. Synthetic server tests prove handoff, parent-only
writes and stop-before-write zero delivery; real Store fence race coverage and
ordinary HTTP composition are separate Runtime gates, not claimed here.

### Worker role transport metadata

The Codex OpenOwnedSession role whitelist is exactly `fast`, `deep`, `worker`.
The broker preserves the issued identity; it never substitutes Deep for Worker.
A Worker channel uses a newly owned process/native session and independent opaque
handle. Same-owner parent and Worker channels cannot exchange handles or native
thread identities. No parent/task claims are accepted as extra JSON fields.

This additive transport support is not Worker admission. Only the trusted Runtime
composition may open it using the eventual Core-issued typed parent/task grant,
consume execution once, and perform actual provider writes under its exact
current lineage fence. Parent revoke/Stop requires that Core-issued fence; role
JSON cannot authorize cancellation, bypass readiness or create a grant. Typed
Worker orchestration and activation remain separate gates. Claude role admission
is unchanged pending its separate typed composition.

## Diagnostics on an installed service

Installed service packages have a closed, protected inventory. Use `python3 -I -S -B` and `PYTHONDONTWRITEBYTECODE=1` when importing their modules for diagnostics; store scripts, caches and output outside the package. Root-owned bytecode is still an unexpected file. The running manager rechecks inventory before admission and child binding, refuses immediately on invalid inventory, and emits one value-free `ALERT orkestr-v2-manager package_inventory_invalid` journal record per invalid episode. Route that record to the operator alert sink. It does not delete files, modify the manifest, accept extra files or weaken child ownership checks.
