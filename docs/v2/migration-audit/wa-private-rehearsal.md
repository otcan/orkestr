# Dormant private-metadata rehearsal boundary

`v2/fixtures/migration-audit/wa-preservation/private_rehearsal.rs` is an explicit
opt-in integration harness for exact Core schema39 `54ad06e408c746b32b67622bce86643d800b1793`.
It reads only a caller-selected 0600 canonical preserved-input DTO array (at most
128 records and 1 MiB), creates a fresh isolated owner/conversation, preserves
metadata, verifies exact authenticated replay and reopened provenance, and checks
that routes, permissions, sends and native admission tables remain empty. It
revokes its fresh target credential before checking replay refusal. Private
assertions do not print evidence values. Targets/receipts remain private.

Harness source `bc0c8c0de` passed one synthetic seven-record test in 0.29 seconds
with no failures/ignored cases; selected strict Clippy, rustfmt and diff passed.
All tracked Core export files were compared byte-for-byte with the pinned source;
only the new integration test was added. Commands, binary/source hashes and logs
are retained in the private rehearsal receipt. This result is synthetic only.

Actual private conversion and execution remain UNEXECUTED pending review of the
source metadata SELECT column order. Retain original tuples rather than guessing.
The canonical source/input revision hashes attest only exact selected metadata;
the independent hold hash attests its selected hold decision, not source authority.
No observed send row maps to no_record/count0, never proof of unsent. Unavailable
classification stays unknown with the observed aggregate count retained. Source
route generation stays unknown unless proven. Original created_at is retained;
canonical observed_at denotes the snapshot observation, never eligibility.
No source payloads, sessions, accounts or credentials are imported. No producer,
route, permission, reservation, socket or outbound operation belongs in rehearsal.
