# Demo Script

Use only public-safe state, fake prompts, and disposable workspaces when
recording Orkestr demos.

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

## 60-Second Walkthrough

1. Open the README and explain the split: Orkestr runs agents; oXRM gives
   agents relationship state.
2. Show `/setup` as the first-run route.
3. Show a thread view with status, queue, and history.
4. Show `/ops` or CLI status for service visibility.
5. Run `npm run demo:coding-agent` and show the pass line.

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

