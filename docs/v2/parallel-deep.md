# Parallel Deep turns within one conversation

Status: phases 1 to 3 are implemented behind the owner switch `parallel_deep`
(default off). See [Phases](#phases) and [What landed](#what-landed).

## Problem

A conversation's window runs one Deep lineage: one canonical Deep binding,
one native thread and one pump. `claims::next` hands it the earliest queued
input, one at a time. When the owner sends three independent requests in a
burst, Fast acknowledges all three at once (concurrent Fast slots, #348).
The Deep answers then arrive one after another, about 4 to 5 minutes apart.
Deep grouping (worktree `deep-burst-grouping`) answers the queued requests
together in the next Deep turn. That still waits for the running turn, and
one turn has to cover unrelated topics.

The goal is for independent requests to get Deep-quality answers at the same
time, without breaking any guarantee the single lineage gives today.

## Decision summary

| Hard part | Decision |
|---|---|
| Workspace conflicts | **Read-only parallel turns plus one serialized writer.** Parallel turns run in a fresh native with the read-only sandbox (no file writes, no network, no MCP or apps). Every write, side effect, timer turn and Worker delegation stays on the canonical lineage. A per-run git worktree that merges at acceptance is a later phase, for writers only. A file-lock or claim protocol is rejected. |
| External side effects | Parallel turns cannot cause any. Enforcement is the same three independent layers that make Fast read-only. A turn that needs an action defers the input to the writer, which still has all of today's guards. |
| Context coherence | Each parallel turn gets a bounded digest of the history up to its source message, as an auxiliary Fast slot does. Parallel answers enter the writer's next turn as a handoff note. A burst final quotes its source message (the `quoteSource` path of #369). |
| Resource admission | The #348 rule (PSI, MemAvailable minus projected cost, swap-in, backstop), with the measured Deep native peak RSS as the slot cost. There is a per-conversation ceiling of 3 slots, a host-wide backstop, and a provider-quota gate. The manager window budget is shared. |
| Recovery | Stop stops every Deep run of the conversation. Crash recovery abandons parallel proposals like any other proposal and keeps the canonical run as the successor anchor. The train's drain counts every live run. |
| Composition | Grouping stays the default. Parallel is an opt-in switch per conversation (`parallel_deep`, default off). When it is on, an input waiting behind a running Deep turn goes to a read-only parallel slot if one is admitted. Whatever remains (deferred, refused by pressure, or arrived while Deep was idle) goes to the next grouped writer turn. |

## Workspace conflicts

Two Deep turns of one conversation share a workspace: the conversation's
working directory on host-full-access instances, the operator's repositories,
`~/.orkestr` state, the browser profile and the desktops.

Options:

1. **Per-run git worktree or copy-on-write workspace, merged at acceptance.**
   This covers only files inside one git repository. Deep turns also edit
   files outside git, run services, write `~/.orkestr` state, drive browsers
   and send messages, and a worktree isolates none of that. A merge conflict
   found at acceptance happens after the side effects have already occurred.
   Two turns can also produce conflicting decisions that each merge cleanly.
   The approach is useful later, for writer turns whose effects are confined
   to one repository (for example "fix X in repo Y" next to "fix Z in repo
   Y"). It needs a declared repository scope, a clean-tree check, and a
   rebase/merge step that the owner sees. That is too large and too
   uncertain for the first version.
2. **File-lock or claim protocol.** A model cannot reliably declare its file
   set before it runs. With `danger-full-access`, any shell command can touch
   any path, so a claim could only be enforced after the fact. This is
   rejected.
3. **Read-only parallel turns plus one serialized writer.** This is the
   chosen option. A read-only sandbox is enforced by the provider for every
   command a turn runs, so the guarantee does not depend on the model
   behaving. Most burst requests are questions, lookups, reviews or plans,
   which are read-only. Anything that writes keeps exactly today's single
   lineage, so today's ordering and conflict behaviour hold for every write.

A read-only turn may still read files while the writer is changing them. It
can therefore report a state that is half-way through an edit. Its answer is
evidence about the moment it ran, the same as a Fast reply. The handoff note
gives the writer the parallel answers, so the writer can correct them.

## External side effects

Grepping the repository found no content-level guard against a Deep turn
sending the same WhatsApp message, email or LinkedIn outreach twice, or
deploying twice. The guards that do exist are:

- one turn per native connection (`codex_rpc.rs` `claim_turn_request`);
- the capacity retry only when the broker proves the turn made no tool call
  (`capacity_fallback.rs`, broker `side_effects`);
- idempotent timers by `request_key` (`agent_timers.rs`);
- V1 `clientMessageId` dedupe of owner input (`sidebar_http.rs`);
- desktop leases, which give mutual exclusion but no send dedupe;
- the train's deploy drain, which drains running conversations around a
  deploy but does not dedupe agent-run deploys.

The real send tools (WhatsApp, Gmail, LinkedIn, deploy scripts) live outside
this repository. Today, safety against duplicates comes from there being one
writer per conversation. That is why parallel turns are read-only.

**Tool-call policy for a parallel turn.** It uses exactly the Fast profile:

1. Runtime requests the Codex `read-only` sandbox with network off and
   requires the provider to confirm it (`CodexRpc`: today `for_role`; the
   scheduler PR adds a read-only flag for a parallel Deep binding).
2. The broker independently forces `FAST_SANDBOX` for that identity
   (`protocol.py`). The native launches with the Fast-style home: no
   `config.toml`, so no MCP servers, rules, hooks or plugins. Apps,
   connectors, browser and desktop control, sub-agents, memories, worktrees
   and dependency installs are disabled (`codex_service/profile.py`). This
   launch-time profile matters as much as the sandbox. An MCP tool runs
   outside the sandbox, so a read-only thread that still had an MCP server
   could send a message.
3. Core refuses every authority a parallel run could use to act:
   - no Worker delegation (a Worker admission whose parent is a parallel
     run is refused);
   - no steering;
   - no timer inputs (`dormant_timer_inputs` are never parallel;
     timers are typically outreach);
   - no thread asks to other conversations;
   - only owner chat inputs.

**Defer.** A parallel turn whose request needs a write or an external action
does not attempt it. It ends with the fixed marker `PARALLEL_DEFER` and no
owner-visible text (the adapter suppresses it the way `NO_REPLY` is
suppressed). Core then returns the input to the writer queue. That needs the
`production_deep_claim` uniqueness split by slot, so that the canonical
lineage can take a deferred input after a parallel run. The split lands with
deferral in the scheduler PR. Until then the schema still guarantees that an
input is consumed by at most one Deep run, canonical or parallel. The
writer turn sees the parallel run's findings in its handoff note, so the
deferral wastes little work. Requests the model misjudges as read-only fail
safely: the sandbox refuses the write, and the answer says the action was not
done. Fast's reply contract is the same.

**Overlapping requests.** Two parallel turns may answer overlapping questions.
Both answers are read-only, so the cost is duplicate text, never a duplicate
effect. Fast's echo suppression (`first_response.py` `repeats_fast`) does not
apply to these finals.

## Context coherence

- **What a parallel turn sees.** A fresh native session with a bounded
  digest of the conversation up to its own source message. It reuses the
  auxiliary Fast slot machinery: `handoff_context::bind` and the
  `fast_digest` bound. It does not see the writer's in-flight turn or the
  inputs queued after it.
- **What the writer sees.** The writer's native thread does not contain the
  parallel Q&A. When it claims its next input, Core prepends a handoff note
  listing the parallel answers accepted since its previous turn: source
  message ID, a one-line restatement, the accepted answer (bounded) and
  whether the run deferred. A follow-up such as "now do what you proposed
  for B" therefore has B's context.
- **Ordering in WhatsApp.** Finals can now complete out of order. Every final
  of a burst is exported with `quoteSource`, the same marker #369 sets for
  concurrent Fast. Core adds `"concurrent_deep": true` to
  `GET .../execution?run_id=` for a run on a parallel slot, or for a
  canonical run while a parallel run of the same window is live. The field is
  absent for a lone run, so the single-turn shape is byte-identical. The V1
  adapter's serial observer today exports only the ledger head's Deep final.
  It gains a parallel watch, like the independent Fast watch: the exact run
  named by the source event is exported as that input's final, quoted.
  Within one input, the final still waits for that input's Fast delivery
  decision (`final_ready`).

## Resource admission

The same live rule as concurrent Fast (`host_pressure.rs`). One more
parallel slot starts only when the current reading shows all of:

- governor gate open (or kernel fallback with CPU some avg60 <= 40 % and
  memory some avg10 <= 10 %);
- memory PSI some avg60 <= 2 % and full avg10 <= 1 %;
- MemAvailable - (live parallel slots + 1) x Deep slot cost >= max(4 GiB,
  10 % of RAM);
- swap-in <= 1 MiB/s averaged over two readings;
- MemAvailable + SwapFree >= reserve + projected use;
- the host-wide start interval (1 s) has passed, and this window has not
  started a slot on this reading yet.

**Deep slot cost.** This is measured the same way as Fast: summed VmHWM of
the native's process tree at reap (`OwnedChild::tree_peak_rss_bytes`). It is
kept as a separate ring (`DeepSlotCost`), because Deep natives are heavier.
A one-off read of the pilot host on 2026-10-27 (four live V2 Deep natives,
read-only `/proc` walk, no PIDs kept) showed 431 to 493 MiB per tree. Four
Fast natives were 166 to 171 MiB. A read-only parallel turn cannot run
builds, so it stays near the native's own peak. The default before any
measurement is therefore 1 GiB, about twice the observed peak. Fast keeps
512 MiB.

**Ceilings.**

- At most 3 parallel slots per conversation (schema CHECK `deep_slot BETWEEN
  0 AND 3`).
- A host-wide backstop of 8 live parallel Deep slots across all windows.
- Live host pressure, not these numbers, is the working limit. This follows
  the "resource-aware, not fixed caps" rule: the ceilings exist only so that
  a wrong reading cannot fork without bound.

**Manager limits.** Parallel slots live inside the conversation's one window.
They therefore consume no extra `MAX_LIVE_WINDOWS` (16) entry and no extra
Runtime window capacity. They do share that window's child set (256, or 512
on host), its 32 egress attempts and its 64 MiB egress bytes. A burst of 3
read-only turns plus the writer stays well inside the child bound, but it
drains the byte and attempt budget sooner. The scheduler stops starting
slots once the window's remaining budget falls below a quarter of its
initial value. When the budget runs out, the window drains (as today), which
fails or stops the remaining turns. Nothing is replayed.

**Provider quota.** All Deep turns of a conversation use one Codex account,
so parallel turns multiply token use. The scheduler reads the passive
`orkestr-provider-quota-v1` projection (`codex.json`, #367). It starts no
parallel slot while the five-hour window is at 80 % or more, or the weekly
window at 90 % or more. With a missing or stale (more than 10 minutes)
projection it starts at most one slot. Quota is advisory, never execution
evidence. A capacity error inside a parallel turn fails that turn alone: its
input defers to the writer and is never retried in parallel.

## Recovery

- **Stop.** The owner's Stop is the conversation's Stop. It cancels the
  canonical run (today's boundary: every queued input up to the cut is held)
  and every live parallel run. Cancelling a parallel run on its own, for a
  deadline, shutdown or budget, holds no other input. A parallel run is
  treated like Fast and Workers in `production_request_cancel`: its own input
  was consumed at admission, and holding the writer's queue for it would
  silently stall unrelated requests. A cancelled or stopped parallel run
  retires its slot binding. It never continues in place.
- **Crash and stranded reconciliation.** Parallel runs are ordinary Deep runs
  of the window's context and incarnation, so the existing steps apply:
  - lapsed runs settle as `lease_expired_process_gone`;
  - an `awaiting_acceptance` parallel proposal on its busy slot binding is
    abandoned like any other.

  The successor anchor is the last canonical Deep run (`deep_slot = 0`),
  never a parallel run. A parallel run's input is consumed, so it is not in
  `unconsumed_inputs` and is not released for re-admission. Nothing is
  dispatched again, the same rule as an abandoned canonical proposal. The
  commit retires every settled parallel slot binding, as it does for
  auxiliary Fast slots.
- **Window retirement.** The window closes on the canonical run as today
  (`terminal_run_id`). Close requires every run of the context to be
  terminal, so parallel runs are accepted, stopped or failed first, and their
  slot tasks have retired their bindings. `retire_terminal_supervisor`
  retires any settled leftover slot. A slot whose run is unresolved keeps the
  window in custody exactly as an unresolved Fast slot does.
- **Train drain.** The deploy drain waits for running conversations. A
  conversation with live parallel runs is running, because its window and
  runs are live. The drain diagnostics count parallel runs as Deep runs of
  the window. No new slot starts once the window is closing, shutdown has
  been requested or the work deadline has passed.

## Core invariants that assume one Deep per window

Each site is either kept, or isolated to the canonical slot (`deep_slot = 0`)
in the first PR. Isolation never changes a result while no parallel binding
exists, which is always the case with the switch off.

| Site | Assumption | Treatment |
|---|---|---|
| `0080` `canonical_role` index | one live Deep binding | index now includes `deep_slot`: one canonical plus at most 3 parallel |
| `0022` `production_deep_claim` | one Deep run per inbox sequence | kept: an input is answered by at most one Deep run. The scheduler PR splits it by slot for defer |
| `0022` `production_occupied_session` | one unfinished run per session | kept: each slot has its own session |
| `runtime/bindings.rs` `ensure` | one Deep binding | canonical only (`deep_slot = 0`) |
| `runtime/claims.rs` `next` | FIFO head, `Busy` on a live claim | canonical skips a head claimed by a parallel slot |
| `runtime/ledger.rs` earliest check | claim is the earliest pending | ignores rows claimed by another parallel slot |
| `production_runtime/status.rs` latest Deep | single latest Deep run | canonical runs only (else `drive_session` would see "scope changed") |
| `thread_asks/mod.rs` running Deep | "the" running Deep run | canonical runs only; parallel runs ask nothing |
| `worker/admission.rs` parent | Deep parent | parallel parent refused |
| `cancellation.rs` Stop boundary | Deep Stop holds the queue | parallel Stop holds nothing else |
| `execution_window/credential.rs` readiness | exactly one Deep readiness per context | canonical readiness only |
| `execution_window/provider_choice.rs` | one Deep binding sets the provider | canonical only |
| `stranded.rs` anchor | last Deep run | last canonical Deep run |
| `stranded_commit.rs`, `stranded_lapse.rs`, `terminal_retirement.rs` | no Deep leftovers | retire settled parallel slots |
| `retired_context.rs`, `stranded_open.rs`, `lifecycle.rs` | one predecessor lineage | kept: anchored on `terminal_run_id`, which is always canonical |
| `native_reset.rs`, `provider_handoff.rs` | retire the Deep binding | kept: they retire every Fast and Deep binding, parallel ones included |
| `owned_execution/session.rs` | one pump, status run is ours | kept: parallel slots run in their own task with exact-run status |
| `execution_registry.rs`, `execution.rs` Stop | one Stop control | scheduler PR: Stop fans out to live parallel runs |
| `ledger.py` (manager) | one run per window record | kept: the window record names the canonical run |
| V1 adapter serial observer | only the head exports a final | adapter PR: parallel watch per exact run |

### Migration

`0082_parallel_deep.sql`, stacked on Deep grouping (#377, migration 0081).
#372 (timer handoff) is on hold and renumbers after these if revived. The
runtime phase adds `0083_parallel_deep_runtime.sql`. This migration:

- adds `conversation_settings.parallel_deep` (0/1, default 0);
- adds `session_bindings.deep_slot` (0 to 3, non-zero only for `role = 'deep'`)
  and rebuilds `canonical_role` over `(owner, conversation, role, fast_slot,
  deep_slot)`;
- adds `production_parallel_deep_slots`, recording which window incarnation
  set up each slot session (the same role `production_fast_continuity` plays
  for Fast slots);
- leaves `production_deep_claim` unchanged.

Existing rows become slot 0. No binding, run, input or native ID changes.

## The switch

`parallel_deep` is part of the existing conversation settings
(`GET/PUT /api/v2/conversations/{id}/settings`). It defaults to off.

- An update that omits it keeps the current value. A provider, model or
  decoration change therefore never turns it on or off.
- The GET body contains the field only while it is on. With the switch off,
  the response is byte-identical to today's.
- The runtime reads it live, through `Store::parallel_deep_enabled`, cached
  for at most 2 seconds; any read error means off. No restart or deploy is
  needed. Turning it off starts no new slot. Slots already running finish
  normally.
- Core checks the switch again inside every slot allocation and parallel
  claim, so a stale cache can never start a slot after the owner has turned
  the switch off and Core has seen it.
- Codex only. A Claude conversation can store the value, but Core starts no
  parallel slot for it (Fast slots have the same rule).

## Composition with Deep grouping and auto-steer

- **Grouping (default).** Inputs that queue behind a running Deep turn are
  answered together in the next writer turn.
- **Parallel on.** While the writer is running a turn, the scheduler offers
  the earliest queued owner chat input to a parallel slot, if pressure,
  quota and the ceiling admit one. Admission consumes the input in the same
  transaction, so grouping's next claim never sees it. Inputs that are not
  taken stay queued and are grouped as usual. A deferred input returns to
  the queue and is grouped with the rest. The writer never waits for a
  parallel run, and a parallel run never waits for the writer.
  - Interface for the grouping worker: its multi-input claim must skip rows
    that are `claimed` by a parallel slot (`deep_slot > 0`) and rows that are
    `consumed`. It can use the same predicate as `claims::next` in this PR.
- **Auto-steer.** A message that answers a question asked by the running
  writer turn is steered into that turn, as today. The adapter freezes the
  steer before admission, so such a message never reaches a parallel slot.
- **Fast.** Fast still answers every input first. Its reply contract says "a
  Deep turn is working on this message", which stays true.

## Phases

1. **This PR: switch and Core custody** (read-only-parallel subset):
   - migration 0082;
   - the setting in contracts, Store and HTTP (UI checkbox);
   - Core slot allocation (`allocate_parallel_deep_slot`), the parallel
     claim (`claim_parallel_deep_input`, then the ordinary
     `admit_run`/dispatch path) and slot retirement;
   - canonical isolation of every site in the table above;
   - Stop scoping, crash and stranded handling, and the Worker refusal;
   - tests for both switch states.

   Runtime behaviour is unchanged whether the switch is on or off.
2. **Scheduler and read-only native.** A window `DeepSlots` task alongside
   the writer:
   - live switch, pressure and quota admission, with Deep slot-cost
     measurement;
   - fresh read-only Deep native per slot (Runtime `CodexRpc` read-only flag,
     broker `FAST_SANDBOX` and Fast-style home for a parallel identity);
   - a one-turn drive with exact-run status, auto-accept, slot retirement and
     reap witness custody;
   - Stop fan-out, `PARALLEL_DEFER` handling, and the handoff note;
   - `concurrent_deep` on the exact-run status;
   - end-to-end coverage in `service_roles_http.py`.
3. **Adapter.** The V1 adapter exports parallel finals, quoted, through a
   parallel watch, and suppresses `PARALLEL_DEFER`.
4. **Later, optional.** Parallel writers confined to one git repository,
   with a per-run worktree and an owner-visible merge at acceptance. This is
   only for requests that declare one repository, and only after phases 2
   and 3 have run in production.

## What landed

Phase 1 (#376, migration 0082) and phases 2 and 3 (the runtime PR, migration
0083):

- **Scheduler** (`owned_execution/deep_slots.rs`). One pool task per Codex
  window with the read-only service profile configured:
  - it starts a slot only while the writer runs a turn, the switch is on
    (2 s cache, rechecked by Core), Core reports an eligible queued input
    (`parallel_deep_candidate`), live pressure admits one more Deep-cost slot
    (`admit_one_deep`), and both backstops have room (3 per conversation,
    8 per host);
  - one setup at a time, so a queued input never gets two natives;
  - each slot allocates, sets up a fresh read-only native with the Fast
    service launcher (`open_window_parallel_deep_retained`), claims, admits,
    drives one turn with exact-run status and lease renewal, then defers or
    retires;
  - the measured tree peak RSS of each slot native feeds the Deep slot cost.
- **Read-only, three layers.**
  - Runtime: the slot connection requests and requires the read-only
    sandbox (`CodexRpc::read_only`).
  - Broker: the Fast service broker accepts a Deep identity only as a
    parallel slot, keeps it at `FAST_SANDBOX` and refuses to steer it. The
    native launches with the Fast home, so no MCP servers, apps or hooks.
  - Core: refuses steering and Worker delegation for a slot run, and never
    gives a slot a timer, steer, thread-ask or agent-relayed input. A slot
    native's own thread asks or agent timers (conversation-scoped HTTP
    grants) are stopped only by the network-off sandbox, as for Fast.
- **Turn content** (Core dispatch):
  - a slot turn gets the bounded history digest plus the read-only note;
  - it names a Deep model: the owner's, else the writer's last resolved
    model, else `gpt-6.1-sol`, at `high` effort unless the owner chose one;
  - the writer's next turn carries each accepted parallel answer once.
- **Defer.** An accepted slot answer that is exactly `PARALLEL_DEFER`, or
  a slot turn that failed (for example a provider capacity or quota error),
  returns the input to the writer's queue (`defer_parallel_deep_input`). A
  stopped slot keeps its input, as the writer does. The
  claim uniqueness is split per slot, so the writer takes it exactly once and
  no slot takes it again.
- **Stop and close.**
  - The pool stops every live slot when the writer's run is cancel-requested
    or cancelled. Known gap: a slot that outlives the writer's turn cannot
    be stopped by the owner (the idle writer offers no Stop); it is
    read-only and ends at its own turn end or the window deadline.
  - The writer stops and drains every slot while the window is still active,
    before window retirement and before a late owner-acceptance wait, and
    holds their reap witnesses through close.
  - A slot's own Stop holds no other input.
- **Status markers.** `GET .../execution?run_id=` adds `parallel_deep: true`
  for a slot run and `concurrent_deep: true` for any Deep final of a burst;
  both are absent otherwise.
- **Adapter** (`compat/v1_runtime/parallel_watch.py`):
  - an input behind the head whose own Deep run is a slot settles out of
    ledger order through the ordinary per-input path, quoted;
  - a defer is never exported: the input forgets that run, takes a fresh
    acceptance key and waits for the writer's run;
  - the watch reads the switch from the settings (30 s) and does nothing
    while it is off.
- **Review gate.** Slot answers are accepted by the server, so no slot
  starts while the conversation has `review_before_accepting` on.

Not yet implemented:

- the provider-quota gate on the `codex.json` projection;
- the stop at 25 % of the window's egress budget.

Live host pressure and the ceilings are the only admission limits today.

## Risks

- **Stale reads.** A parallel answer can describe a file state the writer is
  about to change. The handoff note gives the writer the parallel answer, and
  the owner sees both, quoted.
- **Budget drain.** The shared window byte and attempt budget runs out
  sooner. The scheduler stops starting slots at 25 % remaining, and the
  drain behaviour is unchanged.
- **Quota.** Parallel turns use the account's five-hour window faster. The
  quota gate and the 3-slot ceiling bound this.
- **Misjudged deferral.** A request that needs an action can be answered
  read-only, with "not done". This is safe, but the owner may need to resend.
  The defer marker is the mitigation.
- **Migration numbering with grouping.** See [Migration](#migration).
