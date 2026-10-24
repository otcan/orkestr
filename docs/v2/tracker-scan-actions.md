# Tracker scan actions (Stage 3 development)

This source implements the Core transaction boundary and the bounded reader
pool. Scheduler dispatch, local source discovery, HTTP routes and guided setup
are still being connected. It does not activate mail access or automation.

An owner first selects opaque local registry entries for Inbox and Sent and
explicitly acknowledges read-only access. Source decisions have stable keys,
expected revisions and immutable receipts. An interrupted response can recover
its original receipt after a later source change without restoring old settings.
The runtime must resolve registry paths locally; paths and credentials are
absent from the Core wire selection.

An enabled scan timer holds a distinct immutable authority, bound to owner,
conversation, timer generation, source revision, recipe, classifier digest and
the ordinary Stop boundary. A generation cannot also hold a model instruction
or create an ordinary timer input. The old inert claim API cannot advance a
scan timer. Core exposes the typed work kind that the scheduler must select
before attempting work.

The trusted scheduler reserves a bounded reader slot before requesting a
nonserializable Core claim. A read attempt leaves the occurrence due. Claims
carry a ten-second Store-clock lease and the exact supervisor/session identity.
The pool uses dedicated fixed threads, bounded occupied slots and per-owner /
conversation exclusion. Timeout or a dropped waiter requests cancellation; the
actual worker retains custody until it returns. A completed result retains its
slot through the Store commit. Shutdown is joined only after real thread exit.

One result transaction repeats source, recipe, Stop, generation, session and
lease checks, records structured evidence and cursor, claims the canonical
occurrence, advances its schedule and writes an immutable result receipt. An
informative structured change adds one native UI digest; no-news adds none.
These use `tracker_action_digests`, separate from the adapter's chat-delivery
`timer_digests` queue. There is no fabricated reasoning input, provider run,
window, WhatsApp parent or delivery claim. Failure rolls everything back and
leaves the same occurrence eligible, subject to actual reader custody.

Migration 0075 follows the tracker Store/API migration 0074. Historic upgrade
fixtures assert that new action tables remain empty and every prior row is
preserved. Fixtures may remove only empty new tables. Real profile acceptance,
configuration activation and deployment require the separately reviewed train.

Focused development checks are the Store `history_import::timers`,
`production_runtime::timer`, `tracker::tests`, preflight and stranded-upgrade
regressions, plus the server `tracker_scan_pool` tests. Full integration and
rendering checks run in CI on the final source. WhatsApp action reports remain
a separate later contract.
