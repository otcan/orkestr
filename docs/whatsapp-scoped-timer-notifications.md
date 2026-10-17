# Scoped timer notifications and account return

This opt-in extension to the scoped group transport sends **one completed result
per scheduler run**, only for one explicitly configured existing thread/group.
It is separate from owner-message replies and from any self-chat pilot. It does
not copy timers between threads, enable paused timers or revive campaign queues.

The operator adds these fields to the private group config after approval:

```json
{
  "timerNotifications": {
    "enabled": true,
    "threadId": "example-thread",
    "since": "2026-01-01T12:00:00Z",
    "proofDbPath": "/var/lib/example-relay/notification-proofs.sqlite"
  },
  "routeControl": {
    "threadId": "example-thread",
    "routeId": "temporary",
    "dbPath": "/var/lib/example-relay/delivery-route.sqlite"
  }
}
```

Both databases and configuration must be protected operator-owned state. The
relay writes verified notification proofs; the bridge opens proofs read-only.
The shared route ledger is writable by the two approved account transports.
No new account credentials are required. The new `group-notify` command is a
**permission expansion from replies to proactive timer results** and must not
be enabled merely because ordinary replies already work.

Proofs require a real `timer_due` scheduler event, matching owner, timer, thread,
parent input and completed final answer. The timer must remain eligible at send
time. Automatically completed one-shot timers are distinguished from explicit
pauses. Hidden, record-only, NO_REPLY, stale, other-thread and unverified outputs
are rejected. The disabled legacy mirror stays disabled. Notification text has
a Timer source label and the shared update footer. No prompt text is forwarded.

The scanner retains scheduler receipts durably. The existing events API exposes
only its latest 500 events: if that window no longer covers the last poll, the
scanner reports `timer_notification_event_gap` instead of inventing proof or
silently catching up. Missing proof never permits a send. Results expire after
15 minutes; activation and each account switch have a fresh cutoff.

Rendered chunks are frozen atomically before dispatch. Stable run/chunk IDs
survive process restarts and account switches. The bridge requires exact text,
recipient and parent from the protected proof ledger. Provider IDs enter the
existing transport echo ledger. An interrupted reservation or uncertain result
blocks retries and cutover until reconciled; never clear journals to recover.

## Inactive preparation and deployment

Use `scripts/prepare-scoped-group-notifications.mjs <inactive-copy>` to upgrade
an existing group runtime copy. It changes code files only, and rejects unknown
source shapes. Do not copy sessions or tokens into the source repository.

After the approved permission change and exact-commit CI gate, snapshot configs,
unit overrides and SQLite journals. Stage immutable runtime code; preserve the
existing account/session paths. Initialize proof schema and the shared route
ledger, using fresh verified account/eligibility evidence. For first attachment
only, `preserveExistingSince` may retain the original verified input cutoff so
existing conversations are not dropped. Notification `since` is always new.
Reload the group relay and the affected bridge once, with legacy routing still
disabled. Do not restart the application or enable a second self-chat route.

## Reversible return to the primary account

1. Verify provider restriction clearance independently of a countdown, plus the
   existing account's authenticated/ready state, identity and group membership.
   If the saved session cannot resume, stop; pairing is a separate decision.
2. Prepare the same scoped transport on the primary account with exactly this
   thread/group. It must use the same shared route ledger and remain inactive.
   A legacy unrestricted worker is not an equivalent adapter.
3. Quiesce delivery for this thread; verify both local transport journals and
   the shared ledger have no sending/uncertain records. Keep other groups and
   timers unchanged. Disable competing legacy routing for this thread.
4. The operator calls `activate` with the expected old route and verified,
   account-specific evidence no older than five minutes. A transactional
   compare-and-swap changes the active route and cutoff. Both adapters enforce
   it before admitting input and reserving output. An in-flight reservation
   blocks the switch. Old pending inputs/results are retained but not replayed.
5. Verify one fresh owner input, read with `mark_seen=false`, and one permitted
   reply through the selected account. Verify receipt, no duplicate/echo and
   unchanged timer/campaign states. Provider health is not promised by this test.

Rollback uses the same activation gate to return to the still-eligible temporary
account with a fresh cutoff. Keep every ledger, accepted ID and uncertain ID.
If new sends occurred, never roll back to code that ignores the route fence.
Before any new attempt, code/config rollback may restore the exact previous
runtime. After an attempt, stop and reconcile or keep the fenced runtime.

The switch helper does not execute systemctl, change permissions, approve
provider eligibility or schedule an automatic date-based switch. Evidence is
an operator attestation, not a substitute for checking the actual provider.
