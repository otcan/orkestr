# Demo Script

Use only public-safe state, fake prompts, and disposable workspaces when
recording Orkestr demos.

Recording manifest: [Public demo clip](demo-clip.md).

Recorded public-safe desktop demo:
[docs/assets/orkestr-oxrm-live-demo.mp4](assets/orkestr-oxrm-live-demo.mp4).

## Setup

```bash
npm ci
npm run build
npm run demo:coding-agent
```

Expected result:

```text
Coding-agent demo passed
```

For the OSS demo contract path:

```bash
npm run smoke:k3s:oss-demo
```

To reproduce the checked-in live desktop recording:

```bash
npm run demo:record:live
```

## 60-Second Walkthrough

1. Open with the positioning frame: Orkestr runs agents; oXRM gives
   agents relationship state.
2. Show `/setup` as the first-run route.
3. Show a thread view with status, queue, and history.
4. Show the oXRM dashboard with synthetic demo data.
5. Show `npm run demo:coding-agent` and MCP read output.

## 3-Minute Walkthrough

1. Start with the local-first security model.
2. Open setup and show Codex as the first capability.
3. Show how a named thread survives as an operational object.
4. Show timer or watcher intent without using private prompts.
5. Show the deterministic demo contract.
6. Point to oXRM as the first workflow app using the same agent-workstation
   worldview.

## Do Not Show

- Real phone numbers, chats, Gmail data, LinkedIn profiles, or browser sessions.
- Private hostnames, tokens, `.env`, secret manager contents, or overlay files.
- Personal WhatsApp bindings, timers, prompts, or deployment details.
- Claims that Orkestr is a hosted multi-user SaaS or safe to expose raw to the
  public internet.
