# Generic Executor Boundary

Executors turn queued thread or agent messages into completed work for the
generic API and deterministic demos.

Most users should start with Codex threads, not executor adapters. The normal
Codex path is the thread runtime: Orkestr talks to `codex app-server`, starts or
steers turns, records structured status, and imports existing Codex app-server
history when requested. The executor boundary remains useful for tests, demos,
and private adapter experiments that should not depend on a live Codex session.

The public repo provides:

- a registry for executor adapters
- a no-op executor used by tests and demos
- a `codex` adapter slot that intentionally fails when used through the generic executor API
- persisted execution records
- assistant output persistence as normal thread/agent history messages

The public executor interface must stay host-neutral. Do not put private paths,
WhatsApp bindings, or machine-specific Codex launch commands in public adapter
examples. The built-in thread runtime owns the public Codex app-server path.

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

Private deployments can register custom executors without changing
agent inbox/history APIs.

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
