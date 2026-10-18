# Dormant Store implementation candidate

Targets Core contract/schema commit 885eeb90f49b7536b1d2acbee779178778afd4b8.
Implementation lives exclusively in store-sqlite/src/history_import/. Core owns
registration/reexports and migration0016. This candidate does not register itself.

The ordinary Store methods authenticate the current credential inside a
transaction before namespace lookup. Writes acquire BEGIN IMMEDIATE. Bound
production handles refuse. Only history_imports/history_messages are written;
no conversation, native message, inbox, outbox, event, route, timer, provider or
credential is created. Source IDs are inert provenance. Source scope uses exactly
global or project:<lowercase UUID>, as specified by Core.

Import verifies the complete binary digest and ordering, then inserts and verifies
all rows atomically. Replay verifies the stored source/provenance and compares
canonical bytes; it returns the immutable initial receipt even after rollback.
Rollback verifies ordered rows, count, provenance and digest before atomically
marking the batch inactive; rows remain retained. Current receipts report inactive,
and inactive message pages expose no text. Native V2 deltas are outside this ledger
and are never deleted. Any future ledger edit/reference API needs durable rollback
holds before introduction.

history_digest.py implements the exact Core binary digest for producer mapping;
it is distinct from the older proposed-port dormant_history.py oracle and the
collector's JSON snapshot digest. Those earlier digests cannot be supplied as the
Core source_digest. Both Rust and Python pin Core's independent empty-byte vector.
The complete collector-to-request adapter and additional Unicode/project vectors
remain follow-up work; no live import is authorized.

Verification for this source candidate: Python suite 101/101 PASS; rustfmt check
PASS; git diff --check PASS. Six Rust tests are authored but UNEXECUTED, covering
validation/vector, replay/rollback/inactive paging, conflict/corruption, current
auth/expiry and transaction failure. Compilation and strict lint are UNEXECUTED.
Next dependency: Core source review/minimal registration and bounded build admission
against exact Core885eeb90 in a disposable archive with unchanged manifests/lock.
No executable importer, live restore, multi-authority consistency, complete workflow
parity or release acceptance is claimed.
