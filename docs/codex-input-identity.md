# Codex input identity and safe historical repair

## Invariants

The UI message is the canonical user input. Model-only attachment, prompt-file
and mailbox instructions must not replace its displayed text, attachments,
attribution, delivery state or original timestamp during history hydration.

Each submission records a private, versioned attempt ID, owner/thread/runtime
generation, exact serialized-payload digest and pre-submission item inventory.
The runtime acknowledgement records the accepted turn before notification
projection. These submission records are removed from public message payloads.
History binds the native item to the original only within the same owner,
generation and turn, using an existing item identity or a unique exact payload
match. Distinct native item IDs and ambiguous identical inputs remain distinct.
Legacy inputs can use exact reconstructed serialization only within that scope.
Message mutation locks serialize live projection, hydration and operator repair.

Assistant projection preserves established parent and connector routing fields.
A known non-WhatsApp or ambiguous same-turn input does not borrow an unrelated
WhatsApp parent. Native user chronology prefers occurrence timestamps, not turn
completion timestamps; existing original timestamps are never rewritten.

## Uncertain runtime acceptance

A successful response is authoritative. If the response was lost, reconciliation
requires a unique new native item absent from the recorded baseline, matching
the exact payload, generation and submission time. Steering also requires the
target turn and an item occurrence timestamp. Completion time is not acceptance
evidence. Missing, legacy, stale or ambiguous evidence leaves `awaiting_ack`;
the input is not resubmitted, and history scans do not reset the runtime.
Recent delivery claims remain owned by the submitting process. Reconciliation
uses at most five self-scheduled checks, then marks operator-required recovery;
later explicit probes can still confirm acceptance. An operator must investigate
the attempt before choosing any replay. Do not clear the acceptance fence merely
to empty the queue.

## Report-only audit

Run as the authorized local operator with the intended instance environment.
The CLI is not an HTTP or tenant-exposed administration endpoint. Enforce local
operator authorization and the normal sanitizer policy before applying a plan.
Always specify the exact thread and owner. Do not audit unrelated users.

```sh
node scripts/codex-input-repair.mjs --thread THREAD --owner OWNER --report /private/report.json
```

Reporting reads the message repository without triggering history sync, reading
attachment bytes, running an agent or touching a transport. The private report
contains before-images, candidate IDs, parent references and attachment
references. It does not inventory remote connector delivery state. All message
IDs and attachments remain intact; existing outbox references remain valid.
Review ambiguous skips manually. Do not infer identity from timestamps or text
similarity alone.

## Reviewed apply and rollback

After reviewing the exact report and its digest:

```sh
node scripts/codex-input-repair.mjs --apply /private/report.json --approve-digest SHA256 --manifest /private/manifest.json
node scripts/codex-input-repair.mjs --rollback /private/manifest.json --approve-digest SHA256
```

Apply requires the unchanged repository snapshot and an unchanged candidate
plan. A private mode-0600 before-image manifest is fsynced before the storage
transaction. Original inputs gain the native item identity; imported copies
are marked internal and superseded, never deleted. Parent references are
rebound to the canonical message. No delivery/agent/notification hooks run.
Repeated apply is idempotent, including a crash after the storage transaction.
Rollback restores the before-image only if the repaired snapshot is unchanged;
it refuses to overwrite later messages. Repeating rollback or recovering a crash
between restoration and manifest finalization is safe.

Message pages carry superseded IDs independently of pagination so open browser
caches evict hidden copies. A subsequent history refresh uses the bound canonical
item and cannot revive the superseded import. Rollback after later writes needs
a separately reviewed plan; never force snapshot replacement.

## Operational signals and rollout

`orkestr_codex_input_identity_total{outcome}` uses a bounded outcome vocabulary:
item, submission, legacy, unmatched, ambiguous, conflict, accepted, uncertain,
parent_unresolved. No owner/thread/message IDs or payloads are metric labels.
Alert on new conflict/ambiguity or sustained uncertain-acceptance growth. Review
legacy fallback use during rollout and sample uniquely matched originals for
preserved text, attachments and chronology. Unmatched native inputs are expected
when a user submits outside Orkestr; do not page on that counter alone.

Deploy prevention first. Audit affected owned threads without sync, review exact
candidates, then apply one thread at a time. Confirm zero new inputs, connector
sends or agent executions and verify browser cache invalidation. Keep manifests
in private operator storage according to the instance backup/retention policy.
Deployment alone never runs this migration.
