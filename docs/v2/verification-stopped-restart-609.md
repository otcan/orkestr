# Stopped-terminal restart source review

Reviewed exact Core `609ef2a61b1ee2dc0062ff12811eeaee5f415427` independently. No bounded source blocker found. This is source review, with no independent Rust, migration, process or provider execution credited.

Migration 0037 adds a separate stopped-retirement ledger and two read views. It neither rewrites migration 0028 nor backfills graceful provenance. Stopped evidence requires the cancelled consumed run, matching observation generation/fence, cancellation generation/fence/deadline, acknowledged matching control outbox, issued cancellation-acknowledgement lease and owner/conversation-scoped schema-7 event. A terminal label, cancellation intent or NotDispatched result alone does not qualify.

Retirement authenticates the original bound machine context inside the immediate transaction. It checks the exact ready native binding, excludes later binding users and existing continuation reservations, and rejects every sibling without canonical terminal evidence. Only live retirement or its own exact recorded deadline-zero retry succeeds. Expiry and an unmarked zero deadline cannot mint provenance. The mutation is limited to provenance and the supervisor deadline; held inputs remain untouched.

Candidate discovery is authenticated and returns locators only. Reattach rechecks terminal evidence and provenance, exact predecessor incarnation and scope under the write lock. It transfers selected readiness and reserves one typed metadata grant atomically; the existing reservation validator checks the full ready binding and context. It returns no historical dispatch capability. Old setup bindings become Lost, and a second reservation conflicts.

The six added tests were source-inspected: Deep/Fast and provider identity preservation, held-input preservation, intent/NotDispatched refusal, control/binding drift, revoked credentials, unresolved siblings, unmarked/expired contexts, setup-retirement serialization, and exact predecessor/revalidation after retirement. Copy-first test changes include prefix 36 alongside 14/17/31/33, preserve prior rows/checksums and foreign keys, and explicitly require the new ledger to be empty. Reported terminal 25 and preflight 10 passes remain Core-author evidence.

Original Runtime owned-tree reap proof and trusted server ordering remain prerequisites outside Store. This review grants no native cleanup, process restart, held-input release, Fast/Claude composition or provider qualification.
