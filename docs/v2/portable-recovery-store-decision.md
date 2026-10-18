# Portable recovery Store decision

The proposed module-owned DTOs and binary digest at `58e2cdae1f3cf786a885d34a743692723163efad`
are accepted as the bounded starting point, with the additions below before restore
writes. The binary digest is distinct from the Python JSON envelope digest; neither
proves source authority or cross-system consistency.

Core reserves migration 0020 for a separate `history_recovery_restores` ledger.
Migrations 0018 and 0019 belong to independent provider Worker authority. Migration
owns the new recovery module; Core retains SQL allocation and shared registration.
This decision does not register the module or claim executable restore support.

## Restore identity and replay

Add a nonnil `restore_id: Uuid` to the restore request and receipt. Store an outer
row keyed by `(owner_id, restore_id)`, with bundle digest, semantic request digest,
original and delta target namespaces, immutable initial receipt, revision and
active/rolled-back state, plus an immutable rollback receipt when present. Each
child namespace must be uniquely associated with one restore under that owner.
Both children reference existing history ledgers; nothing references execution.
The semantic digest binds the version, bundle digest and both ordered target
namespaces using the same length-delimited binary convention.

Authenticate the exact current credential inside `BEGIN IMMEDIATE` before replay
or writes. Identical semantic replay returns the persisted initial receipt, even
after rollback, without reactivating either batch. A changed bundle or target
namespace under the same restore ID conflicts. An occupied target namespace is
never adopted into a new bundle. Insert both HISTORY_ONLY batches, preserve the
original inactive state, and insert the outer receipt in that one transaction.
No native admission, execution authority or runnable delta is restored.

## Rollback provenance

A dedicated bundle rollback takes `restore_id`, expected outer revision and a
request key. It authenticates in the same write transaction, checks both exact
recorded child revisions, activity and verified content, and changes both or
neither. An initially inactive original stays inactive; its content and revision
must still match the recorded initial state. Retain the outer provenance and
original receipt. Identical rollback replay returns its stored receipt; changed
input conflicts. Individual history rollback must refuse bundle-linked children,
so it cannot partially roll back a restore. Independent changes or unexpected
references hold the whole operation without writes.

## Export and validation

The explicitly named recovery export may expose retained inactive text after
current-auth verification in its fixed read transaction and again before delivery.
Ordinary inactive reads remain unchanged. Require distinct source namespaces and
validate the complete ordered source fingerprints, receipt linkage and disjoint
message IDs. Apply bounded aggregate rows and bytes to the complete bundle as well
as existing per-ledger bounds. Capture native published content in the same cut;
this remains content recovery, never restoration of native execution state.

Before activation, exercise current-auth refusal, identical/changed replay,
occupied or swapped targets, partial-write rollback, both commit crash windows,
initial inactivity, child tampering and whole-bundle rollback/reopen. Source-only
DTO review provides none of that execution credit.
