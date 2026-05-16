# Executors

Executors turn queued thread or agent messages into completed work.

The public repo provides:

- a registry for executor adapters
- a no-op executor used by tests and demos
- a `codex` adapter slot that intentionally fails until configured by a private overlay or host package
- persisted execution records
- assistant output persistence as normal thread/agent history messages

The public executor interface must stay host-neutral. Do not put tmux, byobu, private paths, WhatsApp bindings, or machine-specific Codex launch commands in the public core.

Current API:

```text
GET /api/executors
GET /api/executions
POST /api/threads/:id/run-next
POST /api/agents/:id/run-next
```

`POST /api/threads/:id/run-next` and `POST /api/agents/:id/run-next` accept:

```json
{
  "executorId": "noop"
}
```

Private deployments can register a real Codex executor later without changing agent inbox/history APIs.

Private overlays can load adapter modules:

```json
{
  "executors": {
    "default": "private-codex",
    "modules": ["./executors/private-codex.js"]
  }
}
```

Adapter modules may export `executorAdapter`, `executorAdapters`, or a `register({ registerExecutorAdapter, env })` function.

Minimal adapter:

```js
export const executorAdapter = {
  id: "private-codex",
  label: "Private Codex",
async run({ message }) {
    return { output: `Processed: ${message.text}` };
  }
};
```

Thread-aware adapters receive `{ thread, message, execution, env }`. Agent
compatibility calls receive `{ agentId, message, execution, env }`.
