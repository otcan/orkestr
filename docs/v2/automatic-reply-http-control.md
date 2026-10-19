# Owner automatic-reply policy control

Core read/contract checkpoint `d8b86f5e2` adds policy sampling to schema39.
UI agreed the four-field projection before the HTTP leaf was implemented. This
read and decision surface grants no producer, ingress, native-role, send,
manual-send, import or held-input release authority. Imported evidence remains
dormant and never replayed. No transport is activated.

Coordinator registers the new `automatic_reply_control` module and nests its
`router()` under `/api/v2` inside the existing browser guard. There are no shared
router/authentication changes in the leaf. The matching integration source used
for private-export compilation is `b98a48353` plus the exact Core projection files
and leaf. Tests register the leaf mechanically only inside the disposable export.

## Read

`GET /api/v2/conversations/{conversation}/automatic-reply-permissions`
accepts only optional `after_id` (nonnil UUID, exclusive) and `limit` (default16,
1..32). It returns `AutomaticReplyPermissionPage`:

```json
{
  "conversation_id": "00000000-0000-0000-0000-000000000001",
  "observed_at_ms": 0,
  "routes": [
    {
      "route_id": "00000000-0000-0000-0000-000000000002",
      "route_generation": 1,
      "permission_revision": 0,
      "enabled": false
    }
  ],
  "next_after": null
}
```

Routes are strictly increasing UUIDs. `next_after` is the last returned UUID only
when more rows exist. An empty page is valid. Pages are independent authenticated
read transactions, not a retained multi-page cut. There are no account labels,
context identities, capabilities or transport readiness fields.

The original namespaced browser credential is reauthenticated in the same SQLite
read transaction as conversation ownership and the page. A bound machine Store
cannot call this owner read. No writes or new authority are created. Revocation
committed before that transaction refuses the read.

`observed_at_ms` is sampled Store time, not a durable revision or a promise of
server clock monotonicity. UI binds owner/session/conversation, request generation
and requested cursor; late requests cannot replace newer samples. For an exact
route, generation and permission revision identify policy: changed `enabled` at
the same versions is invalid. A receipt replay is historical and must trigger a
new read before current policy is shown. Separate pages may observe concurrent
changes and must not be relabelled as an atomic full list.

## Decision

`POST` at the same path (no query parameters) accepts the existing strict
`AutomaticReplyPermissionRequest` and returns the unchanged
`AutomaticReplyPermissionReceipt`. Body limit is2048 bytes. The owner supplies the
sampled exact route generation and permission revision plus an immutable request
key. Retries retain every field. CAS or changed-key-content conflicts are409.
An exact historical receipt can replay after route replacement; it does not
assert that its old permission is still current. Trusted route replacement
increments generation and disables permission. Default route policy is disabled.

Both handlers require cookie authentication; machine Bearer or mixed credentials
are rejected. POST requires the canonical Host/Origin and CSRF checks, including
inside the handler. The Store rechecks the exact original credential before
receipt replay or mutation; a cached owner preflight is insufficient.

Missing/foreign conversation is401 (existing schema39 coalesced scope semantics),
not an empty list. Missing route in an owned conversation is404. Invalid input or
query is400, rejected Origin/CSRF is403, and storage failure is503. Successful
responses inherit canonical `no-store` and `nosniff` headers. Existing early
outer-guard refusals are owned by the shared guard, not this leaf.

UI wording may say “Automatic replies allowed” / “Automatic replies paused”.
Neither means that a connector is running or any input/send is authorized.
Permission changes never release an explicit per-input hold, recall bytes,
confirm delivery, or enable manual sending.

## Bounded validation

The new Store projection/validator tests pass2/2; the complete focused automatic-reply Store suite passes14/14, including existing crash-window tests. The disposable integration
export runs one actual Unix-socket HTTP test spanning empty/default policy,
cookie versus machine/mixed identity, Host/Origin/CSRF refusal, strict query/body
bounds, exclusive paging, valid decision, exact retry, changed/stale conflicts,
foreign scope, trusted replacement with immutable old receipt, and revoked read
and historical mutation refusal. That HTTP test passes1/1. Strict server
all-target Clippy passes with no manifest/lock changes. No connector/native child
or actual send is involved. Shared router mounting and independent review remain
separate coordinator gates.
