# Explicit bounded Codex composition

This optional Linux x86-64 package connects the ordinary server's existing
execution factory to the selected-account isolated Codex profile. It is a finite
operator-owned execution window, not an installer default or an automatically
renewed service. Preparing a package starts nothing and never reads, copies,
hashes, refreshes or substitutes the selected provider authentication file.

## Inventory and scope

The integration base `02ae71dcb3585bced75eb1a5434e703fca1eefad` already contains
the ordinary execution configuration, authenticated admission, acceptance,
control and recovery paths; the provider broker protocol; the sole native
stdin writer handoff on FD3; and strict parent-only resume metadata on FD4.
It does not contain the selected isolation profile or its trusted outer proxy.
The ordinary unprivileged local installer intentionally does not inherit an
execution configuration or provider credentials.

This leaf adds the dependency-closed Codex isolation files from reviewed
`d104ccc39ddaa9c19948a265829e996c90c580df`, plus a supported composition:

| Surface | Public entry and responsibility |
| --- | --- |
| Packaging | `v2/packaging/selected_codex.py` copies exact committed module blobs and already-built protected ELF files into a fresh protected package. |
| Broker | `codex_bounded/broker.py` selects the fixed profile, keeps ordinary protocol/FD3/FD4 semantics, and delegates pump cleanup to the existing product broker. |
| Profile | `codex_bounded/profile.py` explicitly selects `codex-bounded`; the old `SelectedCodexProfile` entry remains unchanged. |
| Controller | `codex_bounded/controller.py` owns one dropped-UID ordinary server at a time and a shared outer egress budget across controlled server replacements. |
| Peer boundary | `codex_bounded/peer.py` verifies UID, PID/start, ancestry, interpreter, exact arguments and mounted source inodes before admitting a local channel. |
| Server lifetime | `server_child.py` installs a parent-death signal after dropping privileges and execs the fixed server with an allowlisted environment. |

No Rust factory, Worker, Claude, installed service, default local installer,
canonical login, native executable or existing profile is modified. Worker and
Fast configurations are refused by the original single-Deep package format. The
server's ordinary Deep factory remains responsible for durable authority,
revocation, Stop, completion proposals and owner acceptance; this wrapper
cannot manufacture or accept a completion.

The separately selected [two-role package](selected-codex-roles.md) uses those
same public components and finite aggregate budget to configure distinct Fast
and Deep native sessions. It does not reinterpret an existing single-role plan.

## Fixed policy

This explicit role disables Codex plugins with the supported
`-c features.plugins=false`. Plugin loading, plugin skills/hooks and associated
warmups are therefore absent in this role. Account/read and model routing still
use the selected provider's normal protocol. No refresh command, token route,
API-key fallback or alternative account is introduced. A false refresh request
does not prove that native internals never attempt recovery after an HTTP 401.

Both proxy layers have eight active relays and four FIFO pending relays. The
outer controller counts at most 32 authenticated local channel attempts for
the whole window, including replacement natives and controlled server epochs.
The shared 64 MiB budget combines both directions; each byte is atomically
charged once before forwarding, without refunds. Per-tunnel limits remain
64 MiB and 900 seconds. The complete window is explicitly 1..900 seconds;
the bounded acceptance recipe uses 120 seconds. Native limits remain 600 CPU
seconds, 8 GiB address space, 256 MiB file size and 256 descriptors.

The setup deadline is two seconds from the inner accept, including both queues,
header reads, DNS and connection establishment. A fixed private prelude carries
that same-host monotonic timestamp; it conveys no authority. Future, stale,
truncated and malformed records are refused, and the outer accept cannot grant
a later deadline. Pending channels forward no CONNECT or encrypted payload.
Cancelled setup kills and joins its owned DNS child. Active encrypted streams
are never evicted merely because they appear idle.

Only exact `chatgpt.com:443` CONNECT requests and public numeric DNS results are
allowed. Canonical authentication is a read-only mount; native persistent
session state is a separate private directory. The existing private filesystem,
network/PID/user namespaces, seccomp policy, no-new-namespace rules, descriptor
fences and parent-death lifetime remain intact. There is no TLS inspection.

Eight active pairs plus four pending pairs retain up to 24 inner relay socket
descriptors. The outer layer retains up to 20 relay descriptors (eight pairs
and four pending local channels). Listener/interpreter descriptors, transient
process-launch pipes and kernel buffers are additional. At most eight DNS
children run concurrently. These are finite per-window limits, not estimates
of all process memory or kernel socket allocation.

## Prepare, review, then explicitly run

The following is a recipe, not authorization to use an existing account. An
operator must first create a fresh ordinary V2 home, complete its owner setup,
and issue a scoped ordinary machine session using the supported API. Preserve
that private bootstrap and machine-token file. No token belongs in the plan,
command line, manifest or public evidence. The configured data home, workspace,
native state and canonical auth reference must be distinct.

Build the ordinary native server from the same final commit as these Python
sources, with the embedded `ORKESTR_V2_BUILD_IDENTITY` record. Stage the server
and selected native ELF under root-owned non-writable ancestors. The preparer
checks the embedded source identity and copies all modules from the exact Git
commit; dirty/newer source and mixed binary revisions are refused. Hashes bind
the chosen files, not a signed distribution or independently reproducible build.

Create a root-owned protected JSON plan outside the repository with exactly:

```json
{
  "format": "orkestr-v2-codex-bounded-plan-v1",
  "output": "/srv/example/packages/fresh-selected-codex",
  "source_repository": "/srv/example/source",
  "source_commit": "0000000000000000000000000000000000000000",
  "server": "/srv/example/artifacts/server",
  "native": "/srv/example/artifacts/selected-native",
  "uid": 1000,
  "gid": 1000,
  "home": "/srv/example/private/v2-home",
  "workspace": "/srv/example/private/workspace",
  "state_root": "/srv/example/private/fresh-native-state",
  "auth_file": "/srv/example/canonical/auth.json",
  "egress_directory": "/srv/example/endpoints/fresh-window",
  "bootstrap_file": "/srv/example/private/v2-home/bootstrap.token",
  "machine_token_file": "/srv/example/private/v2-home/machine.token",
  "conversation_id": "11111111-2222-4333-8444-555555555555",
  "namespace": "selected-example",
  "supervisor_key": "selected-example-owner",
  "port": 32100,
  "lifetime_seconds": 120
}
```

All example paths, IDs and the commit are placeholders. The home, its `data/`
and `provider-home/`, workspace and empty native state are mode 0700, owned by
the chosen non-root UID. Bootstrap and machine-token files are private mode
0600 files. The canonical auth reference is metadata-validated only. The
package and endpoint destinations must not exist and their parents must be
root-owned and not writable by other users.

```sh
# Preparation only; run the packager from the exact source commit.
sudo env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /usr/bin/python3 -I -B v2/packaging/selected_codex.py --plan "$root_plan"
# Inspect the returned manifest, all pins and private references before activation.
# Only after a separate operator review/authorization:
sudo env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  /usr/bin/python3 -I -B "$package/controller.py" "$manifest_sha256"
```

The controller never copies credentials or installs/restarts a service. Its
server child receives the ordinary V2 bootstrap only; native credentials reach
only the selected namespace through the read-only mount. Ordinary HTTP/browser
authentication is still required. The wrapper does not submit inputs.

The trusted `Runtime.start()` / `stop_server()` API permits an explicitly
controlled server replacement inside the same window, with the same Budget
object, byte/attempt counts and original deadline. It never retries a failed
run or releases held inputs. The CLI runs one server epoch and performs joined
cleanup on termination. Any forced, abnormal or incomplete cleanup permanently
blocks another epoch, even if a later cleanup attempt succeeds. A retained
root-owned `window.started` marker prevents
another controller from silently resetting the aggregate. A new window is a
new explicit operator action with fresh protected metadata; a crash leaves
evidence for attended reconciliation, not automatic restart.

## Validation boundaries

The generic finite proxy, protected-package negative cases, actual dropped-UID
server ownership/replacement and actual namespace peer refusals are synthetic
tests. Run ordinary nonprivileged tests normally; the protected filesystem and
namespace cases require an explicit disposable root test invocation:

```sh
cd v2/provider-broker
python3 -B -m unittest test_bounded_role test_bounded_proxy test_bounded_dns
sudo env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -B -m unittest \
  test_selected_codex test_selected_codex_peers -v
```

Those tests create only fresh fixture directories, synthetic account files and
owned children. No installed provider, live account, public service or managed
browser is used. Same-commit ordinary HTTP plus synthetic native acceptance,
independent review, and then separately authorized real-provider acceptance
are distinct qualification gates. This source alone is not full production
replacement, generic installer credential setup, managed refresh, or Claude
qualification.
