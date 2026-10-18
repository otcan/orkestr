# Prepared recovery acceptance

`codex_recovery.py` prepares the next independent ordinary-server acceptance.
It is not yet qualified against a composed recovery artifact. A reviewed
immutable server/broker/native package and matching synthetic proof are required
before any real provider launch. No previous Stop or two-turn receipt qualifies
these new lifecycle paths.

The proposed bounded sequence uses one fresh isolated owner conversation:

1. Start a harmless streamed turn, then admit one distinct input before Stop.
   Submit the original run/control snapshot once. Require explicit provider
   Stopped evidence and disappearance of its owned native process.
2. Verify the old input is still present, unconsumed and undispatched, with exact
   message/event identity and durable Stop-boundary provenance. Submit a new
   post-Stop input. It must get a fresh run/attempt and new owned process through
   strict resume of the same durable native session.
3. Verify the exact historical Stop receipt cannot mutate that successor. Accept
   its durable completion through the authenticated owner route. Gracefully stop
   the server and verify no historical run or held input was rewritten.
4. Restart with the identical execution configuration and state. No bootstrap,
   marker or owned directory is deleted. Submit a third, fresh input after the
   restart. Require a new supervisor incarnation and native process, the same
   durable session and prior accepted answer context, and an explicit owner
   acceptance. Historical acceptance replay must leave the successor unchanged.

Final evidence requires three distinct runs with one attempt each, states
Cancelled/Succeeded/Succeeded, one held pre-Stop input, two acceptances, one
acknowledged Stop intent, one durable native session and complete normal cleanup.
Cross-process Stop delivery/replay is not assumed available: the driver never
submits the old Stop request to the restarted server. Steering, other roles,
crash recovery and OS credential isolation remain outside this acceptance.

The read-only ledger oracle requires the schema-25 held-input tables and the
schema-28 explicit graceful retirement provenance. It refuses a candidate
without those tables before activation; this is
a source prerequisite, not permission to invent or modify production state.
Reconcile against the final committed schema and ordinary server pin before
sealing a package. Provider content stays private; receipts contain only hashes,
counters and fixed outcomes. Each streamed response has a 45-second deadline;
the complete CLI has a 180-second guard and protected bounded process cleanup.

The package must use manifest schema 3 with the six reviewed broker modules and
the exact protected lifetime launcher. Provider-reported PIDs are namespace
local. Process evidence comes only from the owned server's externally observed
host descendants, with start identity, UID and exact native executable. Cleanup
signals only the original server `Popen` handle; an observed surviving child
fails acceptance and is never treated as authority to signal that PID.

`codex_recovery_peer.c` is a deliberately fixed synthetic ELF for the same driver.
It accepts only a fresh start followed by two strict resumes, one turn in each
process. Its private workspace trace labels namespace PIDs explicitly and does
not make a host cleanup claim. A workspace lock rejects overlapping peers;
held-input dispatch, fresh-session substitution and repeated turns fail. It
preserves only synthetic tokens in that isolated workspace, uses no credentials
or network, and must be compiled with `cc -O2 -Wall -Wextra -Werror` before its
exact binary hash is sealed into a synthetic-only acceptance package.
