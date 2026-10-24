# Tracker scan actions (Stage 3 development)

This development source connects the Core transaction boundary, local source
registry, bounded reader pool, typed scheduler and owner HTTP actions. The guided
setup and table UI are still being completed. It does not activate mail access
or automation in an installed instance.

An owner first selects opaque local registry entries for Inbox and Sent and
explicitly acknowledges read-only access. Source decisions have stable keys,
expected revisions and immutable receipts. An interrupted response can recover
its original receipt after a later source change without restoring old settings.
The registry stores backing paths locally; HTTP returns opaque references and
folder labels. New references expire after ten minutes; selected references
survive restart. Reads pin the profile identity on its opened directory handle.
Actual traversal currently requires Unix descriptors; other platforms refuse
mail access until an equivalent handle implementation is qualified. Folder
availability does not prove that Thunderbird has finished synchronizing mail.

Check once creates a one-shot typed action atomically on the ordinary scheduler.
It does not enable recurring automation. Cancellation by the client decision key
can arrive before creation and blocks that late request. Recurring automation
requires its own explicit opt-in, reviewed calendar/time zone, settings revision,
timer revision, selected source and exact installed rule identity. Initial disable
advances its settings fence even before an enable exists. Exact receipts recover
before current readiness/rule checks; old requests never re-arm stopped work.
Changing or removing a source disables its old schedules using canonical timer
controls while preserving their audit history.

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
slot through the Store commit. Discovery and deterministic classification also
run on this pool. Each action bounds messages, bytes, events and cursor history;
folder rotation prevents Inbox traffic from starving Sent. Capacity refusals are
operator-visible and keep the occurrence due. Shutdown joins only real exits.

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
`production_runtime::timer`, preflight and reader regressions, plus the server
`tracker_actions_http`, `tracker_scan_pool` and durable scheduler tests. The
synthetic HTTP case discovers Inbox/Sent, commits one informative scan, reopens
the server composition and commits a quiet scan with unchanged mail bytes and
zero ordinary timer inputs. Full integration and
rendering checks run in CI on the final source. WhatsApp action reports remain
a separate later contract.
