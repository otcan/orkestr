# V1 execution retired guard

Orkestr V2 runs the owner threads. V1 stays up as the WhatsApp transport, the
relay, the mailbox service and the desktop-lease service. This guard turns
"V1 runs no model turns" from an operating rule into a code-level guarantee.

The guard is **off by default**. With it off, nothing changes.

## What it does

With the guard on, V1 does not start a model turn on a thread unless one of
these is true:

- the thread is **delegated to V2**: its WhatsApp binding has a remote runtime
  (`remoteThreadId` set, `remoteRuntimeEnabled`/`remoteRouterEnabled` not
  `false`). Input keeps being forwarded to V2 as before;
- the thread is on the **allowlist**, matched by thread id or thread name.

The guard is checked where each runtime admits input, so it applies to every
trigger: owner WhatsApp messages, V1 timers, API/CLI/UI input, mailbox routes,
job signals, thread watches and voice calls.

| Runtime | Admission point |
|---|---|
| all (dispatcher), raw terminal | `runtime-leases.js` `deliverPendingThreadInputs` |
| Codex app-server, including its internal retry timer | `codex-app-server.js` `deliverCodexAppServerPendingInputs` |
| Claude Code | `runtime-claude-code-adapter.js` `deliverClaudeCodePendingInputs` and the turn admission in `sendClaudeCodeInputReserved` |
| api-agent (WhatsApp, API, connectors, voice call this directly) | `tenant-api-agent.js` `processApiAgentThreadInput` |

What it does **not** block: message intake and recording, the WhatsApp relay
and delivery, V2 forwarding and mirroring, desktop leases, timers firing (the
input is recorded, but it does not run), executor commands (`/codex`, `/agent`)
and thread wake/sleep (these start or stop a runtime process, not a turn).

## What a refusal looks like

- The input stays recorded with `state: "queued"`. Its `deliveryState` becomes
  `refused_v1_execution_retired`, and `v1ExecutionRefusedAt` is set.
- One audit event per refused input: `thread_turn_refused_v1_retired`, with
  `threadId`, `messageId`, `source`, `timerId`, `entryPoint`, `runtimeKind`
  and `reason`. Repeated dispatch passes do not log the same input again.
- One operator alert per thread per interval (default 15 minutes), followed by
  a `v1_execution_retired_alert_sent` event. The alert is a watcher alert
  (source `v1_execution_retired`). If
  `ORKESTR_V1_EXECUTION_RETIRED_ALERT_COMMAND` is set, that executable also
  receives the alert JSON on stdin. Use it for `orkestr-notify`, since watcher
  alerts do not reach WhatsApp at the moment.

Refused inputs stay queued, just like they do under a queue hold. If the thread
is later delegated, they are forwarded to V2. If it is allowlisted, they run.
**If the guard is turned off, all refused inputs run in one burst.** Review
them first with `GET /api/threads/:id/queue`.

## Configuration

| Setting | Meaning |
|---|---|
| `ORKESTR_V1_EXECUTION_RETIRED` | `1`/`true` forces the guard on. `0`/`false` forces it off and overrides the file (kill switch). If unset, the file decides. |
| `$ORKESTR_HOME/v1-execution-retired.json` (path override: `ORKESTR_V1_EXECUTION_RETIRED_FILE`) | `{"enabled": true, "allowlist": ["<thread id or name>"]}`. Read on use and cached for 2 s, so it can be flipped **without a V1 restart**. A missing or invalid file means "not configured". An invalid file also logs `v1_execution_retired_config_invalid`. |
| `ORKESTR_V1_EXECUTION_ALLOWLIST` | Thread ids or names, separated by commas or spaces. Merged with the file allowlist. |
| `ORKESTR_V1_EXECUTION_RETIRED_ALERT_INTERVAL_MS` | Per-thread alert interval. Default `900000`. |
| `ORKESTR_V1_EXECUTION_RETIRED_ALERT_COMMAND` | Optional absolute path to an executable. It receives the alert as JSON on stdin. No shell is used, and it times out after 10 s. |

Prefer the flag file: an env change needs a V1 restart, which blips the
WhatsApp transport. Write the file as the V1 service user and make it readable
by that user (do not leave it root-owned `0600`).

## Canary-only test procedure

Run this only against canary threads. **Never post test input into an owner
chat or through an owner WhatsApp account.** Use `orkestr-v2-canary` for the
delegated side, and use a throwaway V1 thread with no WhatsApp binding for the
refusal side.

1. **Pre-flight inventory (read-only).** List non-retired V1 threads that are
   neither delegated nor queue-held, plus their pending inputs. Each one is
   refused once the guard is on. Add any thread that must keep running on V1
   (for example a voice or demo api-agent thread) to the allowlist first.
2. **Create the refusal canary.** Create a V1 thread named
   `v1-retired-canary`. Give it no binding and put nothing in it.
3. **Turn the guard on** by writing `$ORKESTR_HOME/v1-execution-retired.json`
   with `{"enabled": true, "allowlist": []}`. Wait at least 2 s.
4. **Refusal check.** Send one CLI/API input to `v1-retired-canary`. Expect:
   - exactly one `thread_turn_refused_v1_retired` event for that message id;
   - no `turn_lifecycle_started` event for that thread;
   - the message is still `queued`, with `deliveryState: refused_v1_execution_retired`;
   - one `v1_execution_retired_alert_sent` event, plus the configured alert.

   Send a second input within 15 minutes. Expect a second audit event and no
   second alert.
5. **Delegation check.** Send the usual synthetic canary input to
   `orkestr-v2-canary`, through the canary account only. Expect
   `whatsapp_scoped_relay_remote_forwarded` or
   `remote_runtime_local_input_forwarded`, one V2 run and one delivery. Expect
   no `thread_turn_refused_v1_retired` event for it.
6. **Allowlist check (optional).** Add `v1-retired-canary` to the file
   allowlist and send one input. The thread now starts a V1 turn, so do this
   only when that canary thread's runtime is acceptable to run. Then remove it
   from the allowlist again.
7. **Clean up.** Retire `v1-retired-canary`. Its refused inputs stay
   undelivered.

**Rollback:** set `"enabled": false` in the file, or delete the file. Check the
queues of refused threads first (see the burst warning above).
