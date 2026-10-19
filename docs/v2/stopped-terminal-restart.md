# Graceful restart after confirmed Stopped

The existing trusted ports retain their signatures:

```rust
retire_terminal_supervisor(machine_credential, &prior_run) -> Result<()>
terminal_supervisor_candidate(machine_credential, &config, &conversation)
    -> Result<Option<(RunId, String)>>
reattach_terminal_supervisor(machine_credential, config, &prior_run)
    -> Result<(Store, BoundSessionMetadata)>
```

Retirement now accepts an exact canonical Stopped Deep or Fast predecessor as
well as an owner-accepted predecessor. The server must retain the original
Runtime owned-native-tree reap evidence, wait for all owned cleanup, and only
then invoke retirement on its existing bound Store. Core does not interpret an
ACK, EOF, PID, caller boolean, forced death, or loss of transport as Stopped or
as proof of cleanup. This is the same trusted composition boundary used for
accepted retirement; no browser field can invoke it as provider authority.

Migration 0028 references `production_acceptances` in both its prior-run and
event foreign keys. Migration 0037 therefore adds a separate
`production_stopped_retirements` ledger, without rewriting 0028 or backfilling
older rows. It records exact context/incarnation/supervisor generation, prior
run, canonical Stopped observation event, session and ready binding generation.
Two evidence views combine the terminal/provenance reads. They issue no authority.

Stopped qualification requires cancelled state, consumed delivery-unknown
execution, matching cancellation request and acknowledged control outbox,
matching observation/run/control lease generation and fence, and the exact
issued cancellation-acknowledgement-purpose lease and deadline. The observation
must reference the owner/conversation's canonical schema-7 provider_stopped event.
NotDispatched cancellation, ACK-only and unaccepted completion do not qualify.
Every sibling run must have canonical accepted or genuine Stopped evidence;
terminal labels alone are insufficient. An already issued continuation setup
reservation prevents retirement of its predecessor.

Fresh retirement requires a live authenticated original machine context.
Repeating its exact recorded retirement after its own deadline became zero is
idempotent. Natural expiry or legacy deadline zero cannot create provenance.
Retirement fences old authority by setting its supervisor deadline to zero;
execution evidence, receipts, binding/native identity, held inputs and inbox
rows are preserved.

Restart authenticates the current machine credential, matches exact provider,
namespace, supervisor key and immutable graceful provenance, then performs the
expired-predecessor incarnation CAS under BEGIN IMMEDIATE. It transfers only
the selected ready binding's readiness to the new incarnation and reserves one
existing typed terminal metadata grant in the same transaction. It returns no
historical dispatch capability and admits no input. Losing the one-use setup
grant remains reconciliation-required. Other old setup bindings become Lost.

The server must wait for fresh eligible intent before spending a continuation
reservation. Pre-Stop held inputs remain held after reap, shutdown, restart and
new messages. Only independently admitted post-Stop intent may become a fresh
turn through the ordinary admission/reserve/consume path. Owner acceptance of
Deep, Fast or Worker proposals is never synthesized by this operation.

Bounded author validation uses ordinary Store transactions: 25 terminal-filter
tests and 10 preflight tests pass, including populated known-checksum
14/17/31/33/36 copy-first upgrades to 37 with prior-row/FK preservation and an
untouched rollback source. Six new stopped-retirement tests cover Deep/Fast and
Codex/Claude identity preservation, held input preservation, one-use setup races,
exact predecessor CAS, current credential checks, expired/unmarked contexts,
and control/binding drift refusals without writes. Strict feature-enabled
all-target Store Clippy, workspace formatting and diff checks pass. This is
Store evidence; native reap, server restart and provider qualification remain
separate composition checks.
