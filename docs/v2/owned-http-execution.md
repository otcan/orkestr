# Isolated ordinary HTTP execution

The normal server binary now has an explicit local operator opt-in for one
fresh conversation and one owned Codex broker channel. No fixture feature is
required. Without `ORKESTR_V2_EXECUTION_CONFIG`, startup remains
`execution=disabled`; creating a browser session never activates a provider.

This checkpoint supplies the server factory, not production activation. Runtime's
actual downstream provider-write fence and sealed interruption are composed.
Stop is available only for this factory's live registered running turn; absent
or inactive configuration keeps it unavailable. The real broker and its
actual native-stdin FD handoff are exercised with a fixed synthetic executable,
without a real provider or credentials.

## Operator configuration

First start the ordinary disabled server in a new private data home. Set up a
synthetic owner through the existing HTTP setup route, obtain a machine session
and browser session, then stop the server. Save the machine session token to a
mode-0600 private file; it is an Orkestr owner credential, not provider auth.
Do not paste that value into a command, thread, log or committed fixture.

`ORKESTR_V2_EXECUTION_CONFIG` names a canonical absolute mode-0600 JSON file.
Its owner must match the mode-0700 data home. Unknown fields are rejected.
Example paths and identity below are placeholders:

```json
{
  "schema_version": 1,
  "mode": "isolated-acceptance-v1",
  "conversation_id": "00000000-0000-0000-0000-000000000001",
  "machine_token_file": "/private/acceptance/owner-machine.token",
  "launcher": "/reviewed/immutable/broker-launcher",
  "launcher_sha256": "replace-with-reviewed-lowercase-sha256",
  "workspace": "/private/acceptance/workspace",
  "namespace": "subscription:isolated",
  "supervisor_key": "isolated-http-acceptance"
}
```

The selected conversation must belong to the currently authenticated owner and
must have no queued or previous execution. The workspace must be canonical and
separate from the data home. Startup refuses an existing `owned-execution`
directory; it never silently resumes a prior child or replays uncertain input.
The opt-in requires a loopback listener. This is a fresh isolated acceptance
configuration, not restart/recovery or multi-conversation scheduling.

After independent review, the ordinary invocation is:

```sh
ORKESTR_V2_HOME=/private/acceptance/data \
ORKESTR_V2_BIND=127.0.0.1:19822 \
ORKESTR_V2_ORIGIN=http://127.0.0.1:19822 \
ORKESTR_V2_EXECUTION_CONFIG=/private/acceptance/execution.json \
/reviewed/immutable/orkestr-v2-server
```

Supply the existing bootstrap setting through the operator's private environment.
Keep the launcher, its imported broker modules, private broker configuration and
native provider executable in an independently reviewed immutable installation.
The factory checks launcher bytes twice, at configuration and before spawn; this
does not hash its imported dependencies or replace installation ownership.
Only the fixed launcher can select canonical provider credentials. There is no
HTTP field for a program, argv, provider home, credential, binding or grant.

## Lifecycle and evidence

The factory authenticates the current machine session and conversation before
creating supervisor authority. Core's metadata grant starts one owned child;
the correlated setup handshake confirms a persistent native identity. The next
ordinary HTTP message is durably claimed, admitted, reserved and consumed before
the same child receives its capability-derived turn. Replays and uncertain
consumption never start another turn.

Machine authority is rechecked before admission and consumption, and Core checks
it atomically inside the durable operations and transport fences. Revoked or
expired sessions refuse further work. Supervisor heartbeats preserve only an
already-current session; they do not refresh owner authentication. No provider
text, credentials or private configuration is printed in runtime diagnostics.

The bounded output pump persists each observation before reading the next. HTTP
progress references removable owner-scoped payloads. A completion proposal remains
AwaitingAcceptance until the separate cookie/Origin/CSRF-protected owner decision
commits schema-9 acceptance. Logical payload removal never rewrites the journal.

Setup is bounded to 15 seconds; an admitted run to 45 seconds. Timeout/shutdown
requests a durable fence before local cleanup. Local child exit is not proof of
provider Stop. Unexpected loss stays uncertain and requires reconciliation.
Shutdown signals the owned supervisor before waiting for HTTP connections, and
HTTP drain is bounded to two seconds; an open SSE stream cannot retain the child.
The same child remains quiescent while awaiting owner acceptance and after
accepted completion, with current-session checks and supervisor heartbeats.
It spends no old execution authority while waiting. After committed owner
acceptance, the factory claims the earliest remaining input and consumes a new
Core run grant. `CodexPump::attach_next` requires the same owner, conversation,
native session and the next binding generation. It transfers the existing child
under the new durable fence and retires the old local authority atomically.
Retained old handles cannot revoke the transferred process. No setup, spawn or
metadata replay occurs. Every failure consumes the new grant and quarantines the
child; uncertain delivery never creates a retry grant.

Messages arriving while a turn runs remain in durable order until acceptance.
The server advertises `steer=false`; this is an ordered follow-up path. Native
request IDs increase, prior native turn IDs are retired, and late old replies or
notifications quarantine the channel. Broker correlation retains a bounded
session history and refuses continuation at its limit; this checkpoint does not
silently replace or reconnect that child. OS/credential isolation,
restart/recovery and real-provider multi-turn/Stop acceptance remain separate gates.

## Browser Stop handoff

The factory advertises Stop only for its current owned running turn, scoped to
the configured owner and conversation. A lifetime guard removes availability on
exit, revocation, panic or abort. The availability check grants no authority:
cookie/Origin/CSRF and Core's current-session, exact revision and durable
cancellation checks still run. Core returns public and private control receipts
from one authenticated transaction. Only the public receipt is serialized.

The private receipt crosses a one-value mailbox for the registered run. Identical
receipt replay never delivers another native interrupt. A closed or lost handoff
leaves durable cancellation unresolved; the factory never reconstructs control
from status or creates another request key. The exact HTTP transaction and
handoff serialize with one bounded provider observation step so cancellation
cannot poison a normal pump write before its receipt arrives. This local lock
is released before waiting for the provider, owner acceptance or more input.

The shared Deep/Worker Stop adapter consumes the owned pump once. A native RPC
acknowledgement leaves `cancel_requested`; only a correctly correlated terminal
`interrupted` event committed by Core produces `cancelled`. Missing terminal
evidence, stale fences, lost handoff or a bounded two-second control timeout
require reconciliation. Cleanup never fabricates Stopped or starts a queued
follow-up. The same authenticated HTTP request can replay its original public
receipt after cleanup without another control write.

Focused verification (only synthetic executables and temporary state):

```sh
cargo test --locked -p orkestr-v2-server --lib owned_execution
cargo test --locked -p orkestr-v2-server --test owned_execution
cargo test --locked -p orkestr-runtime execution::reuse
```

The executable test uses the real default-feature server binary and HTTP setup,
cookie login, message intake, progress read, explicit acceptance and payload
removal. It separately verifies default-disabled startup, queued-input refusal,
revoked startup authentication and ongoing revocation before dispatch. A fifth
case revokes the machine session during an active synthetic turn with a queued
follow-up: the owned native process exits, the follow-up is retained, and no
provider completion or Stopped receipt is fabricated. A sixth case keeps a valid
SSE connection open during shutdown, verifies bounded clean server exit and child
cleanup, and checks the durable cancellation intent without a Stopped receipt. It uses
an environment allowlist, the product broker and an explicitly synthetic native
peer. The broker transfers its sole native stdin writer to Runtime before any
native request; the executable test exercises the normal fenced writes. It never
reads a canonical provider home or launches a real provider.

Two additional executable cases verify accepted two-turn reuse and three inputs
arriving during an active turn. They assert one native PID/readiness/session,
distinct consumed run grants, FIFO delivery, and duplicate intake receipt replay
without another dispatch. The Runtime tests additionally revoke a retained old
authority after transfer, refuse next-run admission before acceptance, and cancel
the next durable run immediately before transfer to prove no new native bytes
are delivered. Revocation initiates cleanup; the tests independently wait for the
owned synthetic child to disappear instead of assuming synchronous reaping.

Two Stop cases use the ordinary executable, browser cookie and fixed native peer.
Wrong CSRF/Origin and stale revisions preserve the cancellation ledger and send
no interrupt. One case holds terminal evidence after the RPC acknowledgement,
then verifies exactly one durable Stopped event after releasing the barrier.
The other supplies only an acknowledgement and verifies bounded cleanup with
the original pending intent, no Stopped event and the queued follow-up retained.
Both replay the exact public receipt without another native control frame.
