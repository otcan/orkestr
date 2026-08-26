# Dependency Security Review — 2026-08-26

This review covers ORK-430 and ORK-431. The lockfile was regenerated from the
declared dependency set without `npm audit fix --force`, framework-major
upgrades, or a `whatsapp-web.js` downgrade.

## Remediation

- Angular framework, compiler, CLI, and build packages are aligned at 21.2.21.
- Nest platform packages resolve to 11.2.3 and Multer resolves to 2.2.0.
- `@modelcontextprotocol/sdk` is 1.30.0; current supported Hono packages resolve
  from its dependency graph.
- `tar` is explicitly held at 7.5.22 so build tooling cannot reintroduce the
  critical affected floor.
- The direct development Puppeteer and the `whatsapp-web.js` Puppeteer
  dependency are resolved to 25.9.0. `@puppeteer/browsers` resolves to 3.2.1,
  and the affected embedded `extract-zip` path is absent.
- `whatsapp-web.js` remains at 1.34.7. Its local QR/session transport and the
  alternate supported WhatsApp path are both retained.

`test/dependency-security.test.js` prevents the embedded Puppeteer path or the
reviewed framework/upload floors from silently regressing. A fresh `npm audit`
after lock refresh reports zero advisories across production and development
dependencies.

## Operational validation and rollback

The release gate includes build, upload/security tests, the full WhatsApp test
suite, outbox and recovery coverage, multi-account routing, and a controlled QR
and message canary when an attended account is available. Real WhatsApp E2E is
an optional attended diagnostic and not an implicit send.

Rollback uses the previous versioned Orkestr release. WhatsApp profile and
session material live outside the repository and must not be deleted, migrated,
or replaced as part of a dependency rollback.
