# Tracker scan actions (Stage 3 development)

This development source connects the Core transaction boundary, local source
registry, bounded reader pool, typed scheduler, owner HTTP actions and the Job
tracker tab. Its guided setup separates selecting folders, checking once and
explicit recurring opt-in. This source does not activate mail access or
automation in an installed instance.

An owner first selects opaque local registry entries for Inbox and Sent and
explicitly acknowledges read-only access. Source decisions have stable keys,
expected revisions and immutable receipts. An interrupted response can recover
its original receipt after a later source change without restoring old settings.
The registry stores backing paths locally; HTTP returns opaque references and
folder labels. New references expire after ten minutes; selected references
survive restart. Reads pin the profile identity on its opened directory handle.
Discovery takes an owner/conversation request key and atomically records its
opaque references and response. Retries within the response's ten-minute expiry
return the same references, including after restart. This is expiring metadata
replay, not a durable execution decision: after expiry the owner must discover
again. At most 64 live discovery responses and 256 registry sources are retained
per owner. Discovery and selection checks use a separate bounded metadata pool,
so they cannot consume the scheduled readers' workers or slots.
Each fresh discovery also sweeps up to 64 expired responses across all owners,
using an expiry index; inactive owners need no separate cleanup scheduler.
Actual traversal currently requires Unix descriptors; other platforms refuse
mail access until an equivalent handle implementation is qualified. Folder
availability does not prove that Thunderbird has finished synchronizing mail.
The owner confirms local synchronization as well as read-only access. Browser
recovery records are scoped by authenticated owner and conversation and contain
opaque decisions, never paths or credentials. The exact reviewed source,
settings, timer and rule tuple survives interrupted responses; a concurrent
change revokes the UI approval instead of silently rebasing it.

Check once creates a one-shot typed action atomically on the ordinary scheduler.
It does not enable recurring automation. Cancellation by the client decision key
can arrive before creation and blocks that late request. Recurring automation
requires its own explicit opt-in, reviewed calendar/time zone, settings revision,
timer revision, selected source and exact installed rule identity. A new enable
requires a successfully committed manual
check for that exact source revision, enforced in Core as well as the UI.
The default is hourly, Monday–Friday, 09:00 through 20:00 in the reviewed zone;
daily and fifteen-minute schedules remain explicit alternatives. Initial disable
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
Messages are capped at 4 MiB, MIME attachments are excluded from classification
text and extracted text is capped at 50,000 characters. Reports expose remaining
mail and skipped-entry counters; a bounded scan never implies full catch-up.

One result transaction repeats source, recipe, Stop, generation, session and
lease checks, records structured evidence and cursor, claims the canonical
occurrence, advances its schedule and writes an immutable result receipt. An
informative structured change adds one native UI digest; no-news adds none.
These use `tracker_action_digests`, separate from the adapter's chat-delivery
`timer_digests` queue. There is no fabricated reasoning input, provider run,
window, WhatsApp parent or delivery claim. Failure rolls everything back and
leaves the same occurrence eligible, subject to actual reader custody.
Every action failure, including Invalid/Unauthorized, holds that occurrence with
bounded backoff and an alert. Every five-second controller pass timeout, including
after a committed scan while processing triggers/digests, alerts and backs off the
next pass for five seconds. It preserves already committed receipts and does not
withdraw an uncommitted occurrence or replay a completed one. It cannot
terminate the shared timer controller. Failed cleanup is logged separately and
never replaces the original result; failure to abandon is not cleanup proof.

Each immutable authority stores `read_policy_id=local-mail-v1`. That version
means at most 64 messages, 4 MiB per message, 8 MiB of mbox data per folder,
2,048 remembered mail identities per folder, eight selected folders, 256 total
classified events, 100 events per message and 50,000 extracted characters.
The cooperative read deadline is 1.5 seconds, reader wait two seconds and Core
lease ten seconds. Cancellation/expiry never releases actual reader custody.
Changing these semantics requires a new policy ID; unsupported IDs refuse.
The five-second pass budget cancels the waiting action future; it does not
abandon or expire a Core claim by itself. If cancellation prevents best-effort
abandonment, the `reading` attempt remains fenced until its ten-second lease
expires. A replacement still requires both actual pool custody to end and Core
to admit the next attempt. Late commit repeats the Store-clock lease check.

The immutable `tracker_scan_receipts` row is the typed action outcome, joined to
the canonical occurrence claim in the same transaction. `news=false` is a quiet
successful scan; `news=true` references its native UI digest. `timer_outcomes`
describes model results and includes a `delivered` decision used by the chat
adapter, so a scan must not insert a fabricated model/delivery outcome there.
The supported operator read surface is owner-authenticated
`GET /api/v2/conversations/{id}/tracker/scan-reports`; it reads these receipts
directly (latest twenty), and exact manual receipt lookup includes its result
even outside that page. Action monitoring must use that surface, not infer
success from ordinary model-run statistics or timer-outcome counts. A receipt
and its UI digest provide no WhatsApp or recipient delivery evidence.

Migration 0075 follows the tracker Store/API migration 0074. Historic upgrade
fixtures assert that new action tables remain empty and every prior row is
preserved. Fixtures may remove only empty new tables. Real profile acceptance,
configuration activation and deployment require the separately reviewed train.

Focused development checks are the Store `history_import::timers`,
`production_runtime::timer`, preflight and reader regressions, plus the server
`tracker_actions_http`, `tracker_scan_pool` and durable scheduler tests. The
synthetic HTTP case discovers Inbox/Sent, commits one informative scan, reopens
the server composition and commits a quiet scan with unchanged mail bytes and
zero ordinary timer inputs. It covers a CV attachment above 512 KiB and mail
spanning two bounded scans. Browser scenarios exercise consent, response loss
and reload recovery, explicit recurring enable/stop, concurrent settings changes
and desktop/phone layout. Full integration and rendering checks run in CI on
the final source. WhatsApp action reports remain
a separate later contract.
