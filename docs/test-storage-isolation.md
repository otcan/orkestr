# Test storage isolation

Orkestr tests must never share a writable storage target with a running
instance. The supported test commands install `test/test-bootstrap.mjs` before
application modules load. It removes persistent-path overrides, creates a
unique directory below the operating system temporary root, and sets that
directory as `ORKESTR_HOME`.

Use one of these commands:

```bash
npm test -- test/example.test.js
npm run test:ci
```

Direct `node --test` runs are also fail closed. While Node's test context is
active, Orkestr rejects JSON, secret JSON, and SQLite writes whose resolved
path is outside the system temporary root. Do not add an escape hatch for a
real Orkestr home. Integration tests that require an external database must use
an explicitly provisioned test database and credentials that cannot access
production.

## Persistent-store audit

The storage fence is applied at the common JSON writer and at SQLite open
boundaries that do not use the common writer.

| Store | Persistence shape | Isolation boundary |
| --- | --- | --- |
| Threads | SQLite plus JSON compatibility snapshot | Temporary home, SQLite path guard, generation compare-and-swap, explicit-removal fence |
| Thread messages | SQLite or per-thread JSON | Temporary-home guard before either backend opens |
| WhatsApp bindings and connector state | JSON | Temporary home and common writer guard |
| Connector inbox | SQLite | Explicit database-path guard |
| Connector outbox | SQLite, PostgreSQL, or JSON | Temporary/explicit path guard for local stores; external tests require a dedicated test database |
| Connector attachment staging | Files plus JSON metadata | Explicit staging-root guard |
| Broker instances | SQLite or JSON | Temporary/explicit path guard |
| Thread resource policy and mailbox delivery state | SQLite or PostgreSQL | Temporary/explicit path guard for local stores; external tests require a dedicated test database |
| Mailboxes and Postfix spool | JSON plus RFC 822 spool files | Temporary home, scrubbed overrides, common writer guard, and explicit spool guard |
| Public apps, shared apps, timers, leases, and other registries | JSON | Temporary home, scrubbed path overrides, and common writer guard |

Thread mutations carry the revision of the snapshot they read. A stale writer
is rejected with `thread_registry_revision_conflict`. Any full-registry write
that removes records must provide the exact intended IDs; otherwise it is
rejected with `thread_registry_unexpected_removal`. Rejections append a
critical audit event and normal application mutations increment both the
registry-rejection and critical watcher metrics.

## Lifecycle rule

Repositories and scheduled delivery callbacks capture an immutable environment
when they are created. An embedded server owns its delivery scheduler scope;
`close()` cancels pending timers and awaits in-flight delivery work before it
resolves. Tests should still submit `autoRun: false` whenever execution is not
the behavior under test.

## Defense in depth

CI and production should run under different OS identities or container
boundaries. The test identity must not have write permission to a production
Orkestr home, even if a future regression bypasses application-level guards.
Release verification should record registry counts before and after the full
test suite and exercise backup restore into an isolated temporary home.
