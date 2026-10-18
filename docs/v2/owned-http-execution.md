# Isolated ordinary HTTP execution

The normal server binary now has an explicit local operator opt-in for one
fresh conversation and one owned Codex broker channel. No fixture feature is
required. Without `ORKESTR_V2_EXECUTION_CONFIG`, startup remains
`execution=disabled`; creating a browser session never activates a provider.

This checkpoint supplies the server factory, not production activation. Runtime's
actual downstream provider-write fence and sealed interruption must be reviewed
before a real subscription provider is used. The current ordinary server keeps
Stop unavailable (503, advertised capability false). The real broker and its
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
The channel intentionally processes one turn; persistent follow-up, actual Stop,
OS/credential isolation and real-provider acceptance remain separate work.

Focused verification (only synthetic executables and temporary state):

```sh
cargo test --locked -p orkestr-v2-server --lib owned_execution
cargo test --locked -p orkestr-v2-server --test owned_execution
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
