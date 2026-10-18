# Timer owner HTTP leaf contract

Source: `v2/apps/server/src/timer_http/dto.rs` and `mod.rs`; bounded controller
in `controller.rs`. This is an unregistered leaf until Deep integrates the
existing shared auth/CSRF guard, credential adapter and server lifecycle. Store
baseline is Core e62129f92c282862ace1b04e322f5e1d44bb6ee1, schema 0029. No
common migrations, dependencies, auth implementation or server registration are
changed here. UI must consume these typed fields, not construct due claims.

All routes are relative, owner authenticated, with no query parameters:

| Method | Route | JSON request |
|---|---|---|
| GET | `/api/v2/timers/{namespace}` | none |
| POST | `/api/v2/timers/{namespace}/enable` | `expected_revision` integer, `request_key` string, `conversation_id` UUID, `text` string |
| POST | `/api/v2/timers/{namespace}/control` | `expected_revision` integer, `request_key` string, `action`: `disable`, `stop`, or `rollback` |

Unknown/duplicate body fields refuse; no client clock, due, generation, claim,
owner, credential, legacy prompt or dispatch capability fields exist. UUIDs must
be nonnil. Existing 40 KiB body cap applies. Keys are nonempty, at most128 bytes,
without controls; text is fresh target-owner work, nonblank and at most32768
UTF-8 bytes. Enable derives a domain-separated SHA256 Core request key from the
owner key and text; same key with changed text conflicts. Core also binds target
conversation and expected revision. Requests cannot refresh authority across
Deep Stop or revive stopped/rolled-back timers. Disable permits a fresh explicit
enable with current revision and a new key. Dormant reasons refuse enable.

Every success is HTTP200 JSON with exactly these metadata fields:

- `namespace`, `source_digest`, `revision`, `generation`, `next_due_ms` (nullable).
- `state`: `paused`, `enabled`, `disabled`, `stopped`, `rolled_back`, `exhausted`.
- `dormant_reason` (nullable source-defined reason), `conversation_id` (nullable).
- `schedule`: tagged `kind`: `once` with `due_ms`; `interval` with `every_ms`;
  `utc_clock` with `weekly` and `minute_of_day`; or `dormant` without raw legacy
  metadata. Clock support is explicit UTC; no host timezone fallback.
- `controller_armed` boolean; `controller_hold` nullable, currently
  `explicit_owner_rearm_required` when persisted state is enabled without a
  current local grant. Armed means local grant presence, not proof of execution,
  external delivery, or current session validity between controller checks.

Responses are fresh current metadata, so next due/state may change between
identical requests. Core's immutable occurrence provenance/native receipt dedupe
remains authoritative. This HTTP route does not expose native admission tokens.

Errors use existing ApiError: 400 `invalid_timer`, 401 `unauthorized`, 404
`timer_not_found`, 409 `timer_conflict`, 503 `timer_unavailable`. Existing shared
origin/Host/CSRF/body/deadline guard errors apply separately. Current credential
is rechecked inside every Store transaction before replay; owner scoping avoids
cross-owner reads. The shared adapter must return the exact existing credential
representation, including the browser prefix, after existing auth policy.

Controller: at most32 process-local explicit grants, each at most one hour;
fresh text and credential remain in memory only, never logged/persisted/exported.
Every due delivery reauthenticates through Core. Trusted server clock only;
stable claim key derives from generation and stored due time. One tick is at
most32 deliveries and five seconds; cadence skips missed intervals per Core.
Explicit lifecycle `run(shutdown_receiver)` polls once per second, with skipped
missed ticks, and clears grants at shutdown. No HTTP tick/run endpoint exists.
Server restart, expiry, refusal or absent fresh owner text leaves execution
unarmed, even if persisted schedule says enabled; owner must explicitly rearm.
This bounded capability expires after one hour, so durable unattended timer
execution beyond that remains a release gap rather than silently storing auth.

Deep's minimal integration: register `timer_http` module, merge
`timer_http::routes(controller.clone())` before existing guards/state, implement
`owner_credential(&AppState,&HeaderMap)->Result<(OwnerId,String),Error>` through
existing shared machine/browser auth, and own controller run/shutdown lifecycle.
Do not bypass browser CSRF/Host/origin checks to satisfy the adapter.

Added tests are UNEXECUTED pending exact registered disposable build admission:
actual ephemeral loopback route → explicit enable → fake-clock due → ordinary
input → disable → SQL held oracle, exact replay/text conflict, client-time
injection, revoked auth, and strict duplicate/claim field refusal. No production
registry, live timer, provider, route or outbound channel is activated.
