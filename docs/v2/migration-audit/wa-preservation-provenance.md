# WA copy-only preservation evidence

This is a read-only evidence proposal and independent checker, not the upcoming
Core Store ABI, migration39, permission grant or send reservation implementation.
Core exclusively owns those authoritative types, schema and transactions.
Migration owns only `v2/migration/wa_preservation.py`, its tests and
`v2/fixtures/migration-audit/wa-preservation/`.

## Exact generic provenance proposal sent to Core

An evidence envelope has a nonnil UUID `source_namespace` and opaque
`source_input_identity` (nonempty, <=512 UTF8 bytes, no controls). Together they
identify the source input; identity is never inferred from a timestamp, message
text, chat name or target-native message ID. Real identities stay in the private
overlay. No source identity grants permission or establishes target ownership.

`source_revision` and hold `source_revision` are independently retained as
`{availability: "known", value: lower64hex}` or
`{availability: "unknown", value: null}`. A hash records observed source bytes,
not signed provenance or proof of what a cached process loaded.

`historical_effects` retains every observed classification and count:
`sent`, `sending`, `uncertain`, `unknown`, `no_record`. These are evidence labels,
not native runnable states. Mixed sent/uncertain observations coexist. `no_record`
is absence in a bounded authority snapshot, never proof of unsent work.
Original private receipt tuples remain separately preserved until Core publishes
an exact conversion. Do not guess the meaning of unlabelled legacy columns.

`hold.reason` is `operator_preserved`, `uncertain_effect` or `unknown_effect`.
`source_route_generation` is a known unsigned64 integer or explicit unknown/null.
It is source provenance, never a grant for a current target generation. Capture
observation times per authority; independent snapshots are not a global cut.

The checker compares candidate evidence with the full source provenance,
requiring one distinct dormant hold for every source identity, no dropped
historical count/revision, `replay_policy: "never_replay"`, automatic reply
disabled and skill-only routing disabled. A timestamp newer than a route cutoff
cannot remove a hold. A previous sent receipt cannot convert it into replayable
or implicitly completed work. Unknown generation cannot become a guessed value.

The public fixture uses seven fake identities, all newer than its fake cutoff,
including historical sent, mixed sent/uncertain, in-flight, unknown and no-record
evidence. Two tests cover the positive fixture and ten independent corruptions.
Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s v2/migration/tests -p test_wa_preservation.py -v
PYTHONDONTWRITEBYTECODE=1 python3 v2/migration/wa_preservation.py v2/fixtures/migration-audit/wa-preservation/seven-holds.json
```

These are preservation assertions only. Actual Core import/current-auth,
revocation, permission/hold/route-generation atomic reservation and restart/race
acceptance remain unexecuted until the typed ports are published. There is no
mock sender, importer, queue consumer or socket connection in this artifact.

## Failure-safe authority handoff

Core's selected policy is explicit conversation automatic-reply permission plus
durable per-input holds. Every automatic producer must revalidate current route
generation, permission and hold in the same durable send-reservation transaction.
Imported permission is disabled. Unknown/uncertain effects remain held; historical
sent effects never replay. Explicit/manual authority is a separate decision and
cannot silently authorize automatic replies. The personal skill-only account
remains outside router/autostart membership.

A recovery worker socket override is deployment topology, not enduring mute
policy. The normal UI/gateway/worker path and a separately selected recovery
socket must not be joined as a migration repair: stale outbox work might become
reachable. Preserve the separation until the actual durable fence covers every
producer and retained hold, and pending/uncertain work has a reviewed disposition.
Local deployment intent/evidence belongs only in private receipts.

For all nine workflow groups, retain provenance category (`configuration`,
`recorded_activity`, `process_status`), source revision/observation time and
explicit unresolved coverage. Missing or zero metadata cannot authorize retiring
a workflow. Attachment and timer proofs do not settle unrelated WA authority.
