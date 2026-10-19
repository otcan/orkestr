# Desktop lease local action gate

`DesktopLeaseStore.withCurrentLeaseAction(binding, callback)` serializes a trusted
local action with lease initialization, acquisition, heartbeat, release and
supersession. It always requires a current exclusive lease. The existing
`assertDesktopLeaseForOperation` remains a check-only compatibility API; its
permissive, null-principal and break-glass paths do not authorize this gate.

```js
await store.withCurrentLeaseAction({
  desktopSlug, ownerUserId, threadId, leaseId, fencingVersion, fencingToken,
}, (currentLease) => {
  // One bounded synchronous local operation on an already validated resource.
  // No network, CDP, promise, timer, child process or nested store operation.
});
```

All six fields are mandatory and compared exactly, without normalization or
caller bypass flags. The lease must be unreleased, exclusive, unexpired and
have a current valid heartbeat. The stale heartbeat threshold is the trusted
`ORKESTR_DESKTOP_LEASE_STALE_MS` setting, defaulting to 15 minutes; a heartbeat
over 60 seconds in the future refuses entry. Expiry must be finite even when
legacy permissive acquisition allows a lease without expiry. The callback gets
a copy; it cannot mutate the stored lease through that argument.

This is an internal server API. Its caller must authenticate the owner and retain
the exact authorized binding rather than forwarding arbitrary client JSON.
Context/session epochs, browser resource identity and download-path validation
remain the consumer's responsibility. The gate does not issue a browser context,
install a managed download adapter, or add an HTTP endpoint.

## Supported lock profile

The implementation requires Node.js 22 or newer, Linux, `/usr/bin/flock` from
util-linux, and a local ext, XFS, Btrfs, tmpfs or overlay filesystem. Unsupported
platforms/filesystems and missing or failing helpers refuse access. There is no
NFS/SMB, multi-host, macOS or Windows fencing claim. The Linux installer already
installs util-linux; other packaging must supply it explicitly.

Node opens one persistent `.lock` regular file with no symlink following. A fixed
`flock` subprocess locks inherited FD 3 and exits immediately. Linux retains the
lock in Node's shared open file description after that exit. Node closes its FD
on every operation exit; process death also releases the kernel lock. Normal
unrelated child launches do not inherit this descriptor. The file is never
unlinked by the store, and neither PID age nor mtime can displace a live holder.
Contenders time out, including when a holder is paused by the OS.

The canonical parent directory and lock inode are checked while held. Initialized
JSON records the lock's device/inode identity. A renamed/replaced lock, a hardlink
or symlink, and changed directory identity refuse operation instead of creating
another accepted lock domain. The private state directory and filesystem remain
trusted; this is not a sandbox against a process allowed to rewrite both state
and lock evidence. All cooperating writers must use this store.

## Adoption and recovery

Activation requires stopping **all** old mkdir-lock writers first. An existing
`.lock` directory, however old, is never stolen or deleted by the new code. An
operator must establish that every old writer has stopped before reviewing any
such directory for offline removal. Do not mix old and new store implementations.
This source change does not perform that operational migration.

Gated `init()` adopts structurally valid legacy state by adding only its lock
identity. It preserves lease IDs, tokens, counters, historical records and unknown
fields. It never filters malformed records or resets invalid JSON. The strict
action entry refuses legacy state until initialization succeeds. Repeated init
does not rewrite initialized evidence. Invalid timestamp strings remain available
for diagnosis or ordinary explicit release, but cannot authorize an action.

After initialization, missing state, a missing/mismatched identity, corrupt marker
or invalid lease structure refuses access. State copied to another lock inode
also refuses: backup/restore needs a separate reviewed offline recovery procedure;
there is no automatic rebind or repair command here. Preserve the original state
and lock evidence when diagnosing refusal. Atomic rename protects normal readers
from partial JSON writes; this change does not qualify power-loss durability.

## Bounded work and evidence scope

State reads and writes are limited to 8 MiB. Kernel-lock acquisition retries have
a monotonic deadline of at most 5 seconds, with each nonblocking helper limited
to 1 second. The local per-instance queue, OS scheduling and caller work are not
included in a guaranteed total wall-clock deadline. Async/generator callbacks and
returned thenables are refused. That check cannot undo async work already started
by a misbehaving trusted callback, so consumers must use synchronous local code
only and bound its input/work before entry. Do not wait for network or CDP under
this gate. Expiry is checked at callback entry; an OS pause can delay completion.

The gate orders cooperating local revocation and action entry. It does not provide
remote fencing through a check → remote request → postcheck sequence. A remote
manager must perform the action inside its own serialized authority boundary.

Run `node --test test/desktop-lease-action-gate.test.js` on the supported Linux
profile. Tests use temporary synthetic state and owned subprocesses to cover
paused stale holders, owner death, descriptor inheritance, action/revocation
ordering, exact bindings, corruption, legacy adoption, concurrent init/writers,
counter exhaustion and inode/alias refusal. They do not launch a browser, acquire
a real desktop or modify installed lease state. Passing this suite qualifies the
local source seam, not a live browser/download workflow or distributed fencing.
