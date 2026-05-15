# Executors

Executors turn queued agent messages into completed work.

The public repo provides:

- a registry for executor adapters
- a no-op executor used by tests and demos
- a `codex` adapter slot that intentionally fails until configured by a private overlay or host package
- persisted execution records

The public executor interface must stay host-neutral. Do not put tmux, byobu, private paths, WhatsApp bindings, or machine-specific Codex launch commands in the public core.

Current API:

```text
GET /api/executors
GET /api/executions
POST /api/agents/:id/run-next
```

`POST /api/agents/:id/run-next` accepts:

```json
{
  "executorId": "noop"
}
```

Private deployments can register a real Codex executor later without changing agent inbox/history APIs.
