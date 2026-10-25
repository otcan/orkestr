# Scoped group participant routing

The recovery group transport defaults to owner-authored input. An existing
thread's contact binding alone does not admit non-owner messages at that
transport boundary. Restore a participant only with an explicit per-group
policy in both protected transport and relay configurations:

```json
{
  "workerAccountId": "example-account",
  "participantAuthors": [{
    "chatId": "120000000001@g.us",
    "threadId": "example-thread",
    "ids": ["15550000002@c.us"],
    "since": "2026-01-02T00:00:00Z"
  }]
}
```

The group/thread must already exist in `groups`. `since` must not precede the
transport activation. Choose a fresh activation cutoff: this setting does not
fetch or replay history. Never put a participant into `additionalOwnerAuthors`.
Real policies and originals belong in a private operator repository.

## Admission and delivery

- Accept an exact configured phone ID, or an exact live provider LID-to-phone
  mapping with one unambiguous result. No name matching or cached aliases.
- Store the message and its identity evidence in one SQLite transaction. The
  additive `group_input_author` table leaves prior owner records unchanged.
- Before routing and before each reply chunk, require the current bound thread,
  `allowOtherPeople`, exact `authorizedContactIds`, and stock mirroring disabled.
- The authenticated read-only participant-check endpoint applies current server
  identity policy, binding blocks and global sender blocks. The thread input
  endpoint checks again before enqueue. Requests fail closed on missing state,
  mismatched account, removed grant, or suspicious cross-context/control text.
- Participant metadata is capped at `trusted`, `this-thread-only`, with owner and
  command authority false. Existing owner handling is unchanged.
- Original provider ID, relay idempotency key, reply payload freezing, transport
  receipts, uncertain-send holds and echo suppression remain authoritative.

## Coordinated activation

1. Snapshot current configs, route fence and transport/relay journals through the
   existing operator procedure. Preserve all held input IDs and excluded groups.
2. Release the authenticated server check first. An older server fails closed
   with an unavailable check; it must not be worked around.
3. Copy only an existing, verified participant grant into one group's private
   transport and relay `participantAuthors` entries. Keep recipients, bindings,
   owner authors, notification policy and route fence unchanged.
4. Release the connector code through the release train. Restart the affected
   worker and relay with their existing session, socket and environment. No
   re-pairing, stock gateway activation, alternate transport or historical scan.
5. Verify account health, policy checks, then one fresh authorized participant
   message. Verify its original ID, trusted non-owner metadata, one task and one
   accepted reply; provider acceptance is not proof of delivery or read status.
6. Confirm excluded/blocked participants and other groups have no new grants.

## Rollback

Stop only the scoped relay before changing the worker or its policy. Preserve
both journals and export all `group_input_author.id` values. Add these participant
input IDs to the existing private `heldInputIds` configuration **before** restoring
an older relay: old code cannot interpret their identity evidence and must never
process them as owner inputs. Retain existing holds. Remove the participant grant
from the transport policy; restore the prior reviewed connector version and
configuration through the release train. Keep the additive table and receipts;
never delete inputs, mark unsent messages sent, or retry uncertain deliveries.
The server check can remain installed and inert. No automatic rollback replay.

## Coverage

Synthetic tests cover live LID mapping, wrong groups/accounts, freshness,
transaction rollback, changed evidence, revoked grants, current block lists,
non-owner authority, exactly-once input/reply handling and echo suppression.
No production session, message or credential is used by these tests.
