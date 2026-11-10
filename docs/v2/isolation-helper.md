# Startup storage isolation probe and patch proposal

Status: authored probes and fixture/mocked checks only. Actual candidate failure
and patched-candidate pass are **unexecuted**, pending coordinator admission.
No Rust build, dependency download, server execution, live inference or real home
was used by this helper. This is a proposal, not an implemented security fix.

## Evidence provenance

Read with `git show` from verification commit
`c42b88eed8894430d9cfb6f2be8bda29ec0e800f`:
`docs/v2/intake-independent-evidence.md` and
`v2/acceptance/intake_blackbox.py`. Verification reports that a synthetic legacy
DB symlink target grew from zero to 4096 bytes while startup remained running.
That observation belongs to verification's tested intake head
`28c4779346a2d6e46abed5305cd4b6ee7deac060`; it is not a new execution here.

Source inspection here is at combined candidate
`76f9c6cd91e094329ae5c29c7e95f301366ed02a`:

- `v2/apps/server/src/main.rs`: creates the home before overlap validation,
  canonicalizes homes, compares directory ancestry, then calls `Store::open`.
- `v2/crates/store-sqlite/src/lib.rs`: opens a writable, create-if-missing WAL
  pool before migrations; it does not validate database or sidecar aliases.

Directory separation alone does not establish storage separation. A candidate
DB or sidecar can physically alias another home's files.

## Proposed physical alias policy

Refuse symlink components in the supplied candidate home and its ancestors,
including dangling links; refuse symlink DB, WAL and SHM entries. Refuse existing
nonregular DB/sidecar entries and regular files with link count other than one.
This deliberately rejects hardlinks even when the other name is unknown or
outside the declared legacy home. Never unlink, repair, truncate or migrate an
unsafe entry. Refusal must leave existing bytes, link identities and directory
entries unchanged and create no candidate database/sidecars.

Resolve/check existing legacy and candidate ancestors before creating candidate
subdirectories. Refuse canonical ancestry overlap in either direction. Preserve
valid separated-home startup and allow ordinary single-link existing databases
subject to the core owner's separate schema compatibility policy.

Symlink and inode/link-count checks do not prove separation across bind mounts,
network filesystems, reflinks or hostile mount-namespace changes. Define the
initial supported environment as a local filesystem under a trusted mount
namespace; do not claim sandbox isolation against privileged mount changes.
Compare device/inode identity for known candidate/legacy paths as defense in
depth. Bind-mount alias reproduction is unexecuted and outside these unprivileged
fixtures. Reflinks sharing physical blocks are independent logical files and
are acceptable when writes cannot mutate the original.

## Exact proposed source ownership request

Core owns these changes; this helper has not changed shared source. Delegate
exact files before any implementation by this helper:

1. NEW `v2/crates/store-sqlite/src/path_isolation.rs`: narrow filesystem admission
   helper, no schema or second store. Validate candidate ancestry and the main,
   `-wal`, `-shm` paths using no-follow metadata and link-count policy before any
   SQLite connection or migration. Keep the validation reusable by direct store
   callers, so server-only guards cannot be bypassed through `Store::open`.
2. `v2/crates/store-sqlite/src/lib.rs`: declare/call that helper at the start of
   `Store::open`; preserve a distinguishable isolation refusal for diagnostics.
   Core decides error mapping with the existing application error boundary.
3. `v2/apps/server/src/main.rs`: perform legacy/home overlap and existing-ancestor
   validation before `create_dir_all`; propagate a safe isolation diagnostic.

A metadata-check-then-open sequence alone has a replacement race. The core fix
must state its concurrent filesystem writer threat model. For a hostile writer,
use anchored directory descriptors/no-follow creation and an SQLite opening
strategy that preserves the validated identity for DB and sidecars, or isolate
startup in a directory that writer cannot modify. A second metadata check is
not a complete race fix. Do not add unsafe ad hoc SQLite opening or silently
claim race resistance from canonicalization. Dependency/manifests and any error
contract change remain coordinator-owned. No such dependency is required by
these Python probes.

## Probe contract and admitted execution

`v2/acceptance/isolation/probe.py` allocates and removes its own temporary homes;
it accepts no home argument and inherits only PATH/LANG. HOME, TMPDIR and both
Orkestr homes point inside the disposable fixture. Each subprocess is bounded
and reaped. No credentials or connector configuration is passed. These are
cooperative synthetic filesystem cases, not a process sandbox for untrusted code.

Ten negative cases cover empty/populated/dangling DB symlinks, an ancestor home
symlink, a home symlink, DB hardlinks, WAL/SHM symlinks and WAL/SHM hardlinks.
Refusal requires a nonzero nonsignal exit, a recognizable isolation diagnostic,
and unchanged snapshots of both homes and aliases (names, bytes, link targets,
file device/inode/link count). File timestamps are intentionally excluded since
reading can change access time. Directory inode identity is not asserted.
An eleventh positive case requires HTTP health, a created DB, and unchanged
legacy entries with separate homes. It catches blanket-refusal implementations.
An explicit `--port` is required and must be the coordinator-assigned reserved
lane port. No bind-to-zero or automatic fallback is used. Assignment is an
operator admission requirement; the script cannot independently validate the
coordinator's reservation. Mock tests use a synthetic port value without binding
or launching a process.

Snapshots are captured after launch, immediately before each terminate/kill,
and after exit. JSON reports per-stage changes and their union; both negative
cases and the separated-home control fail on protected changes in any captured
stage, even if shutdown removes/restores them. A child that exits by itself may
already have cleaned up before the next snapshot; these observations cannot
prove the absence of arbitrary transient writes between snapshots. Deterministic
in-process handshakes or syscall tracing would be needed for that stronger claim.

After explicit build/binary execution admission, run against each exact binary:

```sh
python3 -B v2/acceptance/isolation/probe.py \
  --binary /absolute/synthetic-build/orkestr-v2-server --port "$ASSIGNED_LANE_PORT"
```

Expected baseline: negative cases expose acceptance/mutation or an unrelated
SQLite error; suite fails. Expected patched result: all eleven cases pass under
the declared strict alias policy. These are expectations, **unexecuted** here.
Record exact source commit, binary identity, command, JSON and exit code for
each run. Preserve distinction between source inspection and observed behavior.
Timeouts fail negative probes; elapsed time never implies successful refusal.
The suite does not verify WAL effective-schema compatibility, crash durability,
startup permission policy or concurrent symlink replacement resistance.

Executed lightweight check:

```sh
python3 -B -m unittest discover -s v2/acceptance/isolation -p 'test_*.py' -v
```

Result: eight fixture/mocked tests passed. They check all negative fixture shapes,
mutation detection, unrelated-error rejection, no symlink traversal in snapshots,
actual synthetic hardlink identity, exact assigned-port forwarding, and live
mutation evidence retained when mocked terminate/kill removes a sidecar. They
do not establish a server pass. All eleven candidate cases remain **pending /
unexecuted**. CI is **unexecuted** for this helper revision.

## Containment transport handoff

The new `orkestr-runtime/src/containment/` subtree is an independent transport
implementation; Runtime owns parent module registration and provider adapters.
No parent source, dependency, manifest or lockfile is changed here.

`ExecutionScope::new(namespace, incarnation, owner, session, run, generation)`
binds every operation to all six fields. Namespace and incarnation must be copied
from Core's consumed dispatch getters, never supplied by an HTTP caller. All
identifiers are nonempty, at most 128 ASCII letters/digits/`-_.`; generation is
positive. Getters include `namespace()` and `incarnation_id()`.

Trusted composition constructs `Authority::new(scope, Arc<dyn DispatchFence>,
maximum_children)`, then issues an immutable executable/arguments `Executor` with
explicit canonical workspace/home/temp directories and `TransportBounds`.
`Executor::spawn(&scope)` checks the durable fence and local revocation before
starting an owned group. The synchronous fence callback must execute exactly
once while current; it is freshness, **not** a durable inference grant. Lock order
is durable fence, local authority, child. Durable cancellation commits before
local `Authority::revoke()`.

Runtime's private non-Clone wrapper owns Core's
`Box<store_sqlite::ConsumedProviderDispatch>` and implements the crate-private
`ConsumedTurn::into_submission(self) -> (ExecutionScope, Vec<u8>)`. Its scope,
turn text and native binding must derive exclusively from that consumed object
and its authorized provider binding. `OwnedChild::enqueue_turn<D: ConsumedTurn>`
takes the wrapper **by value**. Failure returns `TurnFailure { cause }`, never a
grant; queue-full, revoke, framing and write failures require delivery-unknown /
reconciliation and must not trigger automatic resubmission. There is no
production trait implementation in this subtree and no arbitrary public frame
submission method. Exact Core capability inspected: `7631dea5`.

`enqueue_metadata` parses a strict setup whitelist, canonicalizes JSON before
forwarding, requires `account/read` refreshToken=false and restricts thread/start
to read-only workspace setup. Runtime must also validate provider responses and
keep inference separate. `flush_stdin` performs bounded nonblocking progress;
`poll_stdout` yields one bounded frame, Pending or EOF, with truncated/oversized
output quarantined. Defaults: 64 KiB frame, eight queued frames, 64 KiB I/O per
poll, at most 64 syscalls per poll. Pipe failures discard pending bytes.

Child environment is cleared and replaced with PATH, LANG, LC_ALL, HOME and
TMPDIR only. Inherited nonstdio descriptors are marked close-on-exec. Canonical
subscription access uses an opaque authority-bound `SubscriptionHandle` and a
bounded trusted broker callback, never inherited credentials or auth-home copies.
The actual canonical-auth broker adapter remains Runtime integration work.

Lifecycle signals address only an owned process group; WNOWAIT preserves its
leader identity until group cleanup. Reaping is asynchronous and unreaped children
continue counting against capacity. Revocation discards queued input and stops
owned groups. This transport signal API is not a Core cancellation receipt:
Runtime must not expose cancellation without its separately authorized control
path. Linux 64-bit plus close_range support is required; unsupported operations
fail closed. This is not an OS filesystem/network sandbox. Executable, arguments,
canonical directories and host child-reaping discipline are trusted; hostile
program group escape and concurrent directory replacement need outer containment.

Executed validation in a disposable workspace copy with temporary parent module
registration, unchanged manifests/lock, an isolated target and synthetic homes:

```sh
python3 -B v2/acceptance/isolation/check_transport.py \
  --wrapper "$AUTHORIZED_V2_CARGO" --target "$ISOLATED_TARGET" \
  --home "$DISPOSABLE_HOME_PARENT"
# Add --clippy for: clippy --locked --offline -p orkestr-runtime --all-targets -- -D warnings
```

Result: **18 synthetic tests passed, zero failed**. Coverage includes cross-owner,
namespace, incarnation and generation rejection; revoke-before-dispatch; consumed
grant loss on backpressure; bounded nonreading-child writes; EOF/overflow;
exact environment and inherited descriptor exclusion; metadata restrictions;
owned descendant cleanup and preservation of an unrelated synthetic child.
Final clippy passed with `-D warnings`, including the namespace/incarnation
extension. These checks launch only owned
synthetic Python children. Integrated Runtime/Core inference, actual provider
launch, CI and the eleven database candidate cases remain **unexecuted**. P1 is
not closed by these transport checks.

## Proposed pre-readiness metadata boundary (not implemented)

The execution-only Authority cannot launch metadata before admission: Core's
execution fence requires DeliveryUnknown, whereas native readiness precedes run
admission. Do not substitute a fabricated run or an always-current fence.

Proposed minimal additional API, subject to Core/Runtime review:

```rust,ignore
// No run, message, or execution lease; distinct from ExecutionScope.
MetadataScope { namespace, incarnation, owner, session, binding_generation }
trait MetadataFence: Send + Sync {
    fn dispatch(&self, scope: &MetadataScope,
        action: &mut dyn FnMut() -> Result<(), Error>) -> Result<(), Error>;
}
MetadataAuthority::new(scope: MetadataScope, fence: Arc<dyn MetadataFence>,
    maximum_children: usize) -> Result<MetadataAuthority, Error>;
// Trusted executable/args/directories/bounds, as for Authority::issue_executor.
MetadataAuthority::issue_executor(/* trusted launch configuration */)
    -> Result<MetadataExecutor, Error>;
MetadataExecutor::spawn(&self) -> Result<MetadataChild, Error>;
MetadataChild::enqueue_metadata(&self, frame: &[u8]) -> Result<(), Error>;
MetadataChild::flush_stdin(&self) -> Result<Flush, Error>;
MetadataChild::poll_stdout(&self) -> Result<Output, Error>;
MetadataChild::poll_exit(&self) -> Result<Option<Exit>, Error>;
// crate-private; consumes both non-Clone inputs, including on failure.
MetadataChild::attach_and_enqueue<D: ConsumedTurn>(self, dispatch: D,
    execution_fence: Arc<dyn DispatchFence>) -> Result<OwnedChild, TurnFailure>;
```

MetadataScope is derived only from the authenticated bound-session result and
current supervisor context, never request JSON. Its exact issuer type/getters
are a Core dependency. MetadataFence must call a proposed Core
`with_metadata_fence(binding, action)` which validates authenticated live context,
namespace/incarnation/owner, exact bound session/generation and usable binding
state under one immediate transaction, without requiring readiness or a run.
Only strict whitelisted setup frames, bounded I/O and owned lifecycle operations
are exposed; metadata never implements inference submission or execution scope.
Core must decide the precise accepted pre-ready binding states. Invalidation,
binding replacement, takeover and expiry must prevent further setup writes.

Attachment obtains scope/frame exclusively by consuming Runtime's private wrapper
around the real Core dispatch. It checks namespace/incarnation/owner/session and
binding generation against the original metadata binding. ExecutionScope needs
a separate binding-generation field: the existing generation represents the run
lease and must not be reused as a session-binding generation. Core's execution
fence must validate that exact admitted binding in its existing transaction;
there is no nested call to the metadata durable fence. Runtime must finish and
validate all setup responses before attachment; transport additionally requires
an empty pending-write queue. No process restart, new auth home or credential
copy occurs.

Inside that execution-fence callback, lock metadata ownership, then execution
ownership, then child I/O; reject local revocation, transfer the same process
registration exactly once, and enqueue only the cap-derived turn. Remove its
metadata registry entry before returning, so dropping/revoking the old metadata
authority cannot kill a transferred child. No public raw-scope attach or reverse
transition exists. Execution stdout and lifecycle use only the new authority;
metadata handles are moved, not cloned. A failure after cap consumption kills /
quarantines the child, drops the cap and requires reconciliation. Failure after
any callback side effect, including durable COMMIT failure, must never return a
metadata handle or restore dispatch authority. Existing WNOWAIT/group/reaper
ownership continues unchanged. These are proposed semantics, not executed tests.

Required negative integration checks: pre-ready setup succeeds with real Store;
setup turn/start refuses; mismatched namespace/incarnation/session/binding rejects;
metadata revocation/takeover before attach rejects; attach consumes once; pending
setup writes reject; old-authority revoke after successful transfer leaves the
execution child intact; failed attach never retries or leaks an owned child.
