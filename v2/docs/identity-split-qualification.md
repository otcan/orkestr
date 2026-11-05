# Identity split qualification records

Split startup is closed by default. The sealed service plan may select an
external `qualification_record` path. Its contents are not package inventory
bytes; the path is. This avoids a manifest/record hash cycle. Selecting a path
alone grants nothing. The record, envelopes, typed proofs and raw artifacts must
be single-link, canonical Root-owned regular files, mode 0400, under protected
Root-owned ancestors. JSON shapes, sizes, duplicate keys and hashes are checked.
No Core or provider API can author a record.

`codex_service.qualification_publish.publish(package, phase, evidence)` is a
Root-only atomic publication port for a reviewed private operator finalizer.
It verifies the package, all evidence and the initial persistent hold before
rename and directory fsync. It never invents workflow or migration receipts.
The private finalizer must verify actual qualification artifacts and their
provenance before emitting typed Root proofs. A model report or a caller-supplied
boolean is not qualification. No production record is included in this source.

## Two immutable manager phases

`core_held_bootstrap` requires code and minimal instance-boundary proofs. It
starts only Core with a persistent, external Root maintenance marker already
present. It can provide negative cleanup/status and project descriptor setup,
but cannot admit windows, launch providers, run commands, or release egress.
Changing its record cannot promote that manager. Losing its hold stops it.

`qualified_runtime` additionally requires exact production profile/business
resource proofs and all eight consumer migration proofs. A fresh manager still
requires the persistent Root hold at startup. Before any positive operation it
must observe the actual authority child's fresh `deploy-drain.status.json` ACK,
bound to original PID/start/UID, selected executable inode and held marker inode.
The manager refuses positive operations while the marker exists. A reviewed
operator finalizer may clear the hold only after the credential transaction and
runtime restart are complete. Existing Core/window/operation fences still apply.

Record loss/replacement, malformed status or lost custody fail closed. A new hold
blocks positives. Negative cancellation and cleanup do not depend on a positive
grant. Postdeployment live canaries occur after promotion; they are not circular
prerequisites to the held bootstrap. Failures require rehold and explicit rollback.

## Evidence layout

Under the record's protected parent:

- `evidence/<sha256>.json`: closed envelope `format`, `kind`, `subject`, `receipts`.
- `receipts/<sha256>.json`: closed typed Root proof `format`, `kind`, `slot`,
  `subject`, `artifact_sha256`.
- `artifacts/<sha256>.json`: retained actual JSON artifact, bounded to 4 MiB.

The record has exactly `format`, `phase`, `subject`, and `evidence`. Formats are
`orkestr-split-qualification-v1`, `orkestr-split-evidence-v1`, and
`orkestr-root-qualified-proof-v1`, respectively. Evidence maps kind to envelope
SHA; envelope receipts map each required slot to a distinct proof SHA. Each proof
must bind its kind, slot, exact subject and retained raw artifact SHA.

The `code` subject is source commit, server binary SHA and exact packaged source
module SHA map. Its workflows cover native fresh/resume, native tools/Stop,
workspace commands, attachment export, provider routing, source continuation and
Fast sampling. Synthetic workflow package manifests may differ from production;
they must not be relabeled as production instance proof. Private qualification
must qualify the exact source or explicitly review equivalence before authoring
Root code proofs. The gate does not infer equivalence from an agent narrative.

Other evidence subjects bind the exact production manifest SHA, source commit,
authority UID/GID and executor UID/GID. The manifest includes sealed private
configuration and paths without copying credentials into public evidence.
`boundary` requires Core privacy, executor authority denial, IPC denial and
maintenance-hold proof. `instance` additionally requires provider accounts,
business resources, profile parity and production IPC preflight. Exact private
IPC leaves, tmux sockets and legacy groups belong in the private preflight.

`consumers` requires exactly `root-posts`, `v2-canary`, `claude-canary`,
`timer-handoff`, `new-chat`, `root-source`, `agent-timer-grants`, and `wa-adapter`.
These prove the held credential migration transaction, not later canary success.

The disposable Root test `test_split_qualification.py` exercises actual manager
startup, dropped authority ELF-generated ACK and denial boundaries. Its synthetic
proof artifacts do not qualify real providers, real credentials or a production
identity cutover. No live record, identity, configuration or hold is changed.
