# Claude process initialization

The closed BrokerMetadata operation accepts only an owned-handle-bound frame:

```json
{"type":"control_request","request_id":"setup:1","request":{"subtype":"initialize","hooks":null}}
```

The broker admits this operation once before execution. Its matching successful
control_response is correlated to the metadata outer request. The entire native
response payload is discarded (including account, models, PID and capabilities).
Only the success subtype and matching request ID leave the broker. Unsolicited, duplicate, mismatched, error and malformed responses refuse.
Metadata cannot send user input, interrupt, hooks, models or arbitrary controls.
Runtime must derive this typed setup frame and fence each actual FD write with
Core metadata authority; the broker never writes provider stdin itself.

This is genuine process-protocol initialization, not native session verification,
selected subscription proof or inference completion. The response has no verified
session UUID. A later actual system/init must match the requested private native
UUID; it is never fabricated from this ACK. Runtime/Core readiness must explicitly
resolve that distinction before activation. No fallback to a preinitialized state
or unauthorized first user turn is permitted. Same-process continuation remains
unsupported.

Primary wire reference: [official Python SDK initialize and control request code](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py).
Root independently observed the installed native accepting this metadata-only
handshake without a user frame; this lane ran synthetic process tests only.
