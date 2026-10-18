# Steering schema 34 and timer-only lifecycle source review

Exact reviewed head: `63366a48788b41998ec3fdcabf7de3dc20ca2d97`.
Steering implementation: `1a1f0e683ccc51b63c79767aeb03399ec67d9ac5`.
Timer lifecycle: `b9aa92349429ab613badc3dc404d9672217e86ec`.

No blocking finding in this bounded independent source review. No Cargo tests,
server, scheduler, native provider or process acceptance was executed for this
review. The seven steering, three lifecycle and nine preflight results remain
author evidence.

## Steering

Fresh admission and historical receipt replay authenticate the original current
request credential and bound machine session inside BEGIN IMMEDIATE before
lookup. Replay returns the original receipt without a reservation; changed
semantic input conflicts. Fresh writes additionally require the current context,
exact Running consumed Deep run, current control revision and a projection
revision no greater than the current projection. Scope is owner/conversation/run;
native turn identity comes from a private issuer captured from a genuine consumed
capability, rather than browser input.

Canonical intake and its steering ledger entry commit together. Unsupported or
ordered input stays queued. Reserved steering marks its exact inbox row consumed;
uncertain delivery and explicit rejection cannot release it as a new turn. The
partial unique index limits a run to one reserved/unknown delivery. Schema 34 is
additive, with foreign keys to existing run, conversation, message and event rows;
the preflight test explicitly expects its new tables to be empty after upgrade.
This inspection is not a populated-upgrade execution.

Consumption commits delivery unknown before returning its private non-cloneable
write capability. Each suffix validates browser expiry/revocation, machine and
context authority, immutable original execution envelope, Running state, native
binding, delivery hash and exact durable offset under an immediate transaction.
The local capability is poisoned before validation or callback and is restored
only after successful callback and COMMIT. Callback errors, excessive byte counts
and commit failure therefore cannot authorize another suffix. Zero-byte success
preserves the offset. ACK consumes the capability and changes delivery state only;
it cannot complete or accept the run.

The supplied deferred-constraint COMMIT test executes a byte-counting callback
before an actual deferred foreign-key COMMIT failure, then checks no second
callback and durable offset zero. It is not a native-FD or disk-failure test.
The consume race privately duplicates a reservation inside the test module;
there is no public cloning constructor. Reopen cases retain a live original
handle and do not establish new-process recovery.

Runtime still owns constructing the exact text-only frame, enforcing full frame
length within the Store's 64-KiB bound, retaining the same owned child and matching
the actual native response ID. The Store callback cannot inspect those transport
facts. Renewal changes invalidate this immutable issuer; composition must quiesce
steering rather than manufacture a refreshed capability. HTTP must restrict the
credential to the canonical browser namespace and enforce Origin/CSRF: the Store
authentication helper alone does not impose an HTTP credential namespace.

## Timer-only lifecycle

Bootstrap authenticates the current machine token inside BEGIN IMMEDIATE and
uses fixed owner-scoped namespace/key/provider selection. A live predecessor is
Busy; an expired empty provider context receives a new incarnation and generation.
Any existing readiness or run evidence refuses replacement. Metadata validation
and native readiness confirmation explicitly reject this reserved timer context.

Retirement validates the exact live bound context and current session, refuses
provider evidence, and expires only that incarnation. It creates no native
recovery or reaping proof. The server must stop and join scheduler work before
calling this trusted release operation.

Explicit service renewal validates the current session and live timer context in
the writer transaction, then extends the same auth row toward twelve hours. It
returns an expiry, creates no credential and cannot revive an absent or expired
session. Existing longer expiry is retained by max rather than shortened. Context
heartbeat remains separate; retirement/replacement and explicit revocation fence
old issuers. Daily/weekly scheduling, service shutdown races and process restart
qualification remain outside this source gate.
