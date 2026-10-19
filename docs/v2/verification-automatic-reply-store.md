# Automatic reply Store independent verification

Reviewed exact `54ad06e408c746b32b67622bce86643d800b1793` (schema 39). No bounded source blocker found. This gate covers the Store boundary only; it grants no transport, account or automatic-send activation credit.

The private producer binds current machine context, account, route and generation. Reservations freeze exact output bytes, digest and length and are unique by input and route/request key. Historical reservation replay returns a receipt without recreating authority. Consume commits delivery-unknown before returning a write capability. Every bounded suffix rechecks current authentication, route generation, permission revision and input hold under an immediate transaction. Callback, validation and commit uncertainty poison the capability. Finish retains delivery-unknown rather than asserting external delivery.

Imported evidence remains dormant and held, with no route; trusted fresh ingress cannot promote it. Browser permission operations authenticate before fresh effects or historical lookup. Manual sending is outside this module. Migration 39 adds four tables without importing automatic authority.

An unchanged exact-source export independently passed **12/12 focused tests** and **10/10 preflight tests**, using the locked/offline Cargo wrapper and an isolated target/home. The 12 includes one child entry that returns immediately outside child mode. The process parent exercises four SIGKILL windows and eight fresh-executable inspections. Other supplied cases cover two-pool reservation competition, disable/write ordering, hold/revoke/account replacement, immutable bytes, replay, imported evidence and deferred commit failure after callback bytes. No full-suite or Clippy rerun is claimed.

The crash oracle snapshots eight selected tables, not every database table. Before-commit rows must match; after-commit checks assert changed snapshots plus expected state and zero bytes, rather than a complete explicit row delta. Fresh executable inspections compare durable rows but do not attempt authenticated reserve/consume retries. The deferred SQLite foreign-key commit failure records callback bytes in a synthetic vector; it is not an actual socket write or OS/disk failure test. The disable race combines source transaction ordering with task synchronization, not a database-entry barrier.

Preflight checks preserve populated prefixes 14/17/31/33/36/37/38 through 39, prior rows, foreign keys and checksums, and explicitly require the four new tables empty.

Retained raw log SHA-256: focused `3176623b87fd681513734e1acb33198dd5cc6dd9fc53bb3ceb735dc8beb59a0f`; preflight `e1d1870cba85ed28cf27c642c40955adff6735eef003467b4eaa1f84a78b2f7d`.
