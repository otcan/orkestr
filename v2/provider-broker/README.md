# Trusted owned-session provider broker

This standalone Python standard-library server is a trusted connector, separate
from untrusted workers. It opens a dedicated Codex app-server over stdio with
fixed arguments `app-server --listen stdio://`. It creates a new persistent
native thread per role/channel; it never resumes a V1 thread or connects to a
shared app-server. Claude is explicitly unsupported in this slice.

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
