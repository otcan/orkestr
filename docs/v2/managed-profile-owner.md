# V2 managed-profile owner seam

`isolation/managed_owner.py` implements a cooperating V2 cross-process prototype,
not a production auth cutover. It is unregistered and absent from launcher
inventories. Only trusted private composition constructs
`ProfileOwner(owner_directory, canonical_auth_file, selected_identity, launch)`.
Ordinary server composition receives only a one-use `select()` or successful
`refresh(exchange, expected_identity)` handle. No caller account paths, auth
bytes, environment or provider options are exposed through that handle.

The private owner directory and canonical account parent must be canonical,
current-UID private directories. Auth, lock and ledger must be regular private
single-link files. Directory/device/inode bindings, stable lock/ledger inodes,
and the selected path/identity are checked. The auth inode may change only
through a successful validated refresh transaction; other replacement refuses.
Trusted ancestors and no concurrent malicious directory replacement are required.
This is not a defense against a same-UID host attacker that can rewrite those
private directories; untrusted Worker filesystem/process isolation is separate.

An O_CLOEXEC, no-follow lock and nonblocking flock provide exact-directory
cross-process exclusion. SQLite FULL-synchronous short transactions retain owner
epoch, selected profile/path binding, generation, state and auth inode only.
No canonical credential content is read or copied. A new registered owner epoch
invalidates old cooperating owners and handles. Existing unknown/revoked state
cannot be reopened as ready. A fork-inherited owner is refused. Handles cannot
be copied/serialized and are consumed even on failed launch.

Refresh commits unknown **before** contacting the native peer, then releases the
SQLite transaction while retaining the file lock. The existing
ManagedAccountRefresh callback sends only managed `account/read` with
refreshToken true, validates exact selected account/routing, and bounds its
trusted transport contract. No login, external chatgptAuthTokens, API-key route,
account fallback, turn submission or automatic retry exists. Only a valid current
epoch/unknown result advances generation and publishes the newly bound auth inode.
Revocation can commit during network wait; a late valid reply then cannot publish.
Death, timeout, invalid identity or persistence failure leaves unknown/revoked,
requiring external reconciliation. There is intentionally no reset/reissue API.
A live auth mutation may already have occurred before failure; no rollback of
canonical credentials is implied. Synthetic replacement is atomic, but the pinned
native writer uses truncate/write/flush, not this fixture's replacement strategy.

`launch` is a fixed trusted bounded owned-spawn/fresh read-only-bind callback,
not an inference request. It executes under the local owner fence and a short
ledger transaction. Its composition must install owned cleanup before returning,
retain cleanup ownership across commit failure, and perform all wait/reap outside
this callback. This prototype does not supply that native launcher or Core
inference authority. The selected handle alone never authorizes dispatch.

## Cutover fence still required

Root must provision one immutable owner-directory mapping per exact canonical
profile; different directories do not share flock. All V2 writers and both
legitimate existing native server owners must route refresh/persist through the
same owner, or be prevented from writing by an enforced host policy. Merely
installing this prototype, the native in-process semaphore, disk reload, or a
Python lock does not serialize those existing processes. No such global cutover
is performed or claimed here. Existing owners must not be killed/restarted or
forced to refresh to test it. Root retains private provisioning/activation.

Core/Runtime must separately bind current owner/profile revocation to issued
metadata readiness and every actual inference/control suffix. Existing read-only
isolated auth mounts stay read-only, and an old mount does not see a replacement
inode automatically. Late refresh cannot restore a spent dispatch grant or retry
an uncertain turn. The fresh selected-profile callback remains server-private.
No auth or owner FD may enter an untrusted Worker; reviewed offline sandbox
composition remains a separate owner and must clear environment/FDs.

## Evidence

Eight bounded synthetic tests cover a fake account/read subprocess, coordinated
atomic replacement/fresh reload, independent-process contention, stale owner,
SIGKILL during refresh and refused restart, revoke-before-late-result, alias and
foreign-profile refusal, uncoordinated replacement, and cleared fake-child env/FDs, and concurrent one-use handle consumption.
All account files are disposable fake text. These are not native managed refresh,
actual Worker isolation, Core composition, power-loss durability or production
single-writer evidence. Live refresh and production cutover remain unexecuted.

The supported managed operation is established by pinned GetAccountParams;
[official App Server documentation](https://learn.chatgpt.com/docs/app-server)
also describes account/read. The pinned internal-only external-token restriction
remains authoritative for this release. See
[codex-managed-refresh-boundary.md](codex-managed-refresh-boundary.md) for exact
response validation and public native source lock evidence.
