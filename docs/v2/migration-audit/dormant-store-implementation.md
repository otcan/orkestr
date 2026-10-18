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
core_history.py now maps complete collector pages to the published request and validates import receipts. Additional pinned Unicode/project vectors remain follow-up work; no live import is authorized.

Verification of exact Migration2d491562 against disposable Core885eeb90:
Python suite 101/101 PASS; six Rust history_import tests PASS; strict all-target
clippy with warnings denied PASS; rustfmt and git diff --check PASS. The archive
added only the committed module and temporary module registration; all eleven
manifest/lock/toolchain files were byte-verified unchanged. No source correction
was necessary. Test binary SHA256:
`b825d648d68327043879afdc7bc195087e0bbfbdff17d5f0be3c35fbe335d315`.

Executed through the admitted isolated wrapper/home/target:

```sh
v2-cargo test --offline --locked -p orkestr-v2-store-sqlite history_import -- --test-threads=1
v2-cargo clippy --offline --locked -p orkestr-v2-store-sqlite --all-targets -- -D warnings
```

Core registered successor f316db09c16bffb5ce5778725eb286c9e9dd88c0 contains an
identical history_import subtree, Core-owned registration/reexports and a separate
Core integration oracle. Core separately reports its six Migration tests plus
one concurrent two-pool/reopen/logout/inert-ledger test PASS; this is attributed
to Core, not rerun here. Independent review of the registered successor requested.
No live import, crash acceptance, multi-authority consistency, complete workflow
parity or release acceptance is claimed. Private build receipt stays outside OSS.
