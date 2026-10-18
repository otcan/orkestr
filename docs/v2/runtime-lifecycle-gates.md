# Remaining runtime lifecycle work

The ordinary configured execution checkpoint at `abee5d1c` is bounded to one
fresh conversation. It refuses preexisting execution at startup and returns the
factory after Stop. Neither that checkpoint nor the older `aa8e19a3` artifact
pair establishes a production lifecycle.

The Deep factory owner implements the following after the current Worker slice,
with Core supplying reviewed fresh, resume and takeover authority as required:

- Confirmed Stop followed by a newly and explicitly admitted turn.
- Restart reconciliation of completed and accepted state followed by a new turn.
- Unknown delivery and acknowledgement-only interruption remain held for
  reconciliation, with no automatic redispatch or inferred termination.

The runtime workstream also requires a trusted registry for multiple ordinary
conversations and bounded scheduling across distinct Fast, Deep and independent
Worker sessions. One operator-configured acceptance conversation cannot replace
ordinary daily-use threads. Define registry ownership, per-conversation cleanup,
capacity, authentication, recovery and role scheduling before qualifying this
scope. Provider-internal tool isolation remains a separate boundary.

Each lifecycle requires exact-source ordinary HTTP and owned-process tests;
synthetic and real-provider results remain separately attributed. No release
candidate, deployment or production soak qualification follows from this plan.
