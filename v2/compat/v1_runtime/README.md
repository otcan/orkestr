# Single-chat WhatsApp transition adapter

This optional pilot keeps V1 as the existing WhatsApp transport and sole reply
producer. New owner messages from one explicitly selected V1 binding run in one
saved Rust conversation. It does **not** enable Rust Core's automatic-reply
transport, import old V1 commands, or migrate the linked WhatsApp account.
No dependency beyond Python 3.11+ is needed.

Run tests from the repository root:

```sh
python3 -m unittest discover -s v2/compat/v1_runtime/tests -v
```

Run the loopback-only service from a pinned checkout:

```sh
python3 -m v2.compat.v1_runtime.server --config /private/operator/config.json
```

The config and token files must be regular private JSON files owned by the
service user. The owner credentials reference must resolve through trusted
non-writable parents to a regular mode-0600 owner credential file; provider
`auth.json` is always refused. Cookies and CSRF values remain in memory and
never pass through V1. Do not copy owner credentials into the V1 environment.

Required config fields (actual values belong in private deployment state):

| Field | Meaning |
| --- | --- |
| `origin` | Canonical HTTPS Rust origin |
| `loopback_url` | Rust API at HTTP IPv4 loopback with an explicit port |
| `credentials_path` | Existing owner username/password JSON reference |
| `expected_owner`, `conversation_id` | Exact Rust owner and conversation UUIDs |
| `expected_source` | Pinned deployed Rust source commit |
| `public_thread_id`, `chat_id`, `account_id` | Exact selected V1 scope |
| `remote_thread_id` | Adapter's private route UUID |
| `allowed_principals` | Explicit verified owner sender aliases |
| `excluded_public_ids` | Every V1 input already present at the handoff |
| `token_path` | Private JSON containing a random alphanumeric `token` of at least 32 characters |
| `ledger_path` | Private SQLite file under an existing private directory |
| `listen_port` | Unused unprivileged IPv4 loopback port |
| `automatic_accept_roles` | Explicit owner policy, exactly `["fast", "deep"]` |
| `outbound_role` | Exactly `"deep"` |
| `enabled` | Explicit boolean; keep false during preparation |

The compatibility API requires the configured Bearer secret on every route.
It only admits text from the selected account, group, V1 thread, and verified
owner aliases. Forwarded `originOwner`, command and control flags confer no
additional permission. Attachments and edits receive explicit refusals.

POST intake commits an idempotent ledger entry before acknowledging delivery.
A changed body under the same public message ID is refused. The ledger is
pinned to its owner, conversation, binding scope and acceptance policy; changing
that scope refuses startup before login. Remote user rows retain their original
public message ID and scope so V1 can reconcile a lost intake acknowledgement
without replaying execution or enabling orphan replies. Background work
uses immutable Core message, window and acceptance keys saved before each
mutation. Source message/event IDs correlate provider observations with this
exact input. Both Fast and Deep must complete; the configured policy accepts
both, but only the canonically accepted Deep payload is exported with an
immutable acceptance ID and its matching V1 parent. Other browser inputs,
Worker output, old proposals and unrelated conversations are never mirrored.

This first pilot has a hard capacity of **32 inputs**. V1 has no remote mirror
acknowledgement cursor; retaining all entries at this bound prevents unseen
replies silently leaving the recent-message window. Configure the V1 backend
with `fetchLimit: 100`. Do not prune, rotate or replay the ledger to evade this
limit. Lift the limit only with a reviewed delivery acknowledgement design.

## Cutover prerequisites

1. Obtain the exact selected chat, verify its existing account and verified
   owner identities, and snapshot binding, queue, cursors and history privately.
   Keep the personal German skill-only account outside this router.
2. Deploy V1's remote-binding executor fences first. A queue hold alone cannot
   protect the queued executor-command dispatcher. Preserve a selected-thread
   queue hold through the handoff, and wait for its current local turn to end.
3. Create the target Rust conversation through the normal owner API and retain
   the old history as an archive. Historical text is not fresh execution input.
4. Install the disabled adapter, verify its private scope, then configure the
   existing V1 remote backend registry. Current V1 reads process environment;
   activation requires a controlled API restart that can affect observation of
   other active threads. Check their state before and after that restart.
5. Keep inbound and mirror disabled during the narrow binding update; record
   all preexisting public input IDs as exclusions. Set `remoteBackend`,
   `remoteThreadId`, `remoteRuntimeEnabled` and `remoteMirrorEnabled` through
   supported binding operations. Do not retire, delete or recreate the chat.
6. Enable the adapter and selected binding, then observe a fresh owner message
   through Rust intake, matched execution, canonical acceptance, the original
   mirror and the real transport delivery receipt. Do not claim delivery from
   an adapter HTTP acknowledgement alone.

A busy Rust window remains visible as waiting; the adapter never forces another
conversation to stop. Revocation, scope changes, unexpected terminal execution
or inconsistent receipts block the input for operator review. No alternate
provider, local executor, or direct WhatsApp send is used as a fallback.

## Rollback

Disable the selected binding's inbound/mirror and stop the adapter first.
Reconcile every admitted input and possible transport effect before restoring
its saved binding. Preserve the ledger, Core receipts and existing dedupe
ledgers. Never reset global WhatsApp routing, replay an uncertain send, retire
the production chat, or release the selected queue hold while a delegated input
could still execute locally. Verify the original route with a fresh message.
