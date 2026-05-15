# Job Search Demo

This overlay is intentionally fake and deterministic. It proves the public V1
loop without requiring personal Gmail, LinkedIn, WhatsApp, or Codex credentials.

Run from the repo root:

```bash
npm run demo:job-search
```

The demo script:

- starts a mock WhatsApp bridge
- starts Orkestr with this overlay
- creates the `job-search-assistant`
- routes a fake WhatsApp message into the agent inbox
- runs the demo executor
- verifies the final assistant reply was sent back to the mock bridge exactly once
