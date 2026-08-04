# Task Agents

Task agents are short-lived specialist Codex threads spawned by a parent
thread. They are for bounded delegated work that should return evidence to the
parent without becoming another user-facing chat.

Unlike code workers, task agents:

- share the parent workspace and do not create a Git worktree or branch;
- have no WhatsApp or connector conversation binding;
- run with the profile's narrowed sandbox and approval policy;
- return their final answer as an internal, deduplicated parent-thread input;
- can be listed, inspected, or cancelled independently.

The first built-in profile is `sre_engineer`. It performs read-only,
evidence-first operational investigation and returns Summary, Root cause,
Evidence, Confidence, Unknowns, and Recommended actions. The parent Codex agent
evaluates that result and remains the only agent that answers the user.

## CLI

```bash
orkestr task-agent profiles
orkestr task-agent spawn <parent-thread> "Investigate the failed readiness probe" --profile sre_engineer
orkestr task-agent list <parent-thread>
orkestr task-agent status <task-agent-thread>
orkestr task-agent cancel <task-agent-thread>
```

Use repeated `--context <reference>` flags to pass explicit context references.
Use `--no-run` to create a durably held task that cannot be picked up by
delivery recovery; it remains held until it is cancelled.
Task-agent results are steered into an active parent turn or queued as the next
parent turn when the parent is idle.

## HTTP API

- `GET /api/task-agent-profiles`
- `POST /api/threads/:threadId/task-agents`
- `GET /api/threads/:threadId/task-agents`
- `GET /api/task-agents/:taskAgentId`
- `POST /api/task-agents/:taskAgentId/cancel`

Task agents inherit the parent's Orkestr owner and tenancy boundary. Non-admin
creation and cancellation requests pass through the configured LLM sanitizer.
