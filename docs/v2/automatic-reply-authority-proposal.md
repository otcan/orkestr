# Automatic reply authority: proposed Core boundary

This is a source/API proposal, not an activated transport or an implemented
Store ABI. Core exclusively reserves migration 0039; the current registered
migration directory ends at 0038. Migration owns preservation fixtures only.
Core owns new `contracts/automatic_reply.rs`, `store-sqlite/automatic_reply/`
and their tests. Existing manual sends, native inbox holds, router mirroring
and progress flags do not acquire automatic-send authority through this work.

## Durable identities and proposed operations

The ledger binds owner, conversation, trusted route identity and monotonically
increasing route generation. Route binding comes from trusted connector setup,
not browser JSON or provider output. Permission defaults disabled. An owner
permission change authenticates the original session inside BEGIN IMMEDIATE,
compares permission revision and route generation, and deduplicates an exact
request key. Enabling a new route never releases an existing input hold.

Proposed owner operation:
`set_automatic_reply_permission_authenticated(credential, conversation, request)`.
Request fields are `request_key`, `expected_permission_revision`,
`expected_route_generation`, and `enabled`. Its receipt records the committed
permission revision and route generation; changed semantic retries conflict.
This operation cannot change route identity or release input holds.

Each input has a durable opaque identity and immutable source provenance.
`hold_automatic_reply_input_authenticated` records an exact input hold and
reason under current owner authentication. No timestamp, cutoff, permission
enable, route replacement or restart implicitly releases it. Explicit release
is outside the first slice. Imported records always remain dormant.

`reserve_automatic_reply` accepts a private, nonserializable producer handle
issued from trusted bound connector authority, plus an exact input locator and
idempotency key. Within one write transaction it checks current producer auth,
owner/conversation, current route generation, enabled permission, input hold,
and historical effect state before inserting a reservation. Caller-supplied
IDs or an `automatic` boolean cannot mint this handle. Every automatic producer
must use this operation. Manual explicit sends require a separate owner-send
authority and cannot select a bypass mode on the automatic operation.

Fresh reservation returns a one-use private locator only once. A subsequent
consume records `delivery_unknown` before external bytes and returns a sealed
send capability. Each bounded actual transport write must recheck current
route/permission/hold/revocation under its dedicated fence. Historical receipt
replay never returns a capability. Partial writes, lost replies and reopened
unknown reservations require reconciliation, never blind retry or a new key.
Transport ACK evidence is separate from reservation and from observed output.
No transport adapter is activated by the first Store checkpoint.

## Copy-only preservation contract

Preserve source namespace UUID and opaque source input identity (1..512 UTF8
bytes, no controls). Real identities stay in private overlays. Source revision
is explicitly known with a lowercase 64-hex digest or unknown with no value;
route generation is explicitly known with a nonnegative u64 or unknown.
Observed time is canonical UTC, not an eligibility cutoff.

Retain every historical effect classification and count: `sent`, `sending`,
`uncertain`, `unknown`, `no_record`. No record is not proof of an unsent input.
Preserve explicit hold reason (`operator_preserved`, `uncertain_effect`, or
`unknown_effect`) and its source revision. Sent history can coexist with a hold.
Copied evidence is always dormant, automatic permission disabled and
`never_replay`; import cannot create a producer, route grant or send capability.
Out-of-date or unknown route provenance cannot be promoted implicitly.

Workflow census evidence separately retains its fixed workflow classification,
authority kind (configuration, recorded activity or process status), source
revision, observed time and unresolved flag. Missing or zero evidence never
establishes nonuse. This is preservation evidence, not a send-authority DTO.

## Required first Store tests

Race route replacement, permission disable, explicit hold and revocation against
reservation/consume/actual-write fences; assert no callback on refusal. Cover
all automatic producer entry points, changed-key payload conflicts, historical
sent and unknown refusal, immutable exact replay without reissue, reopen after
consume, copy-only dormant import, and held records newer than any cutoff.
Keep manual-send tests separate and prove they do not release automatic holds.
Migration's independent synthetic preservation checker is complementary and
does not replace these transaction or transport tests.
