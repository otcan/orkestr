# Coding Agent Demo Log

This is a sanitized public demo log. It uses fake local paths and no private IDs.

## Task

```text
Inspect this repo and list the top three public-launch blockers. Do not edit files.
```

## Dry-Run Command

```bash
npm run demo:coding-agent
```

## Expected Output

```text
Coding-agent demo passed
Server: http://127.0.0.1:19815
Thread: demo-coding-agent (Demo Coding Agent)
Virtual desktop profile: /tmp/orkestr-coding-demo-xxxx/browsers/desktop
Queued task: Inspect this repository and list the top three public-launch blockers. Do not edit files.
Next real-agent step: run `npx orkestr-oss wake demo-coding-agent` with Codex installed and logged in.
```

## Real-Agent Follow-Up

```bash
npx orkestr-oss wake demo-coding-agent
npx orkestr-oss attach demo-coding-agent
```

The public dry run proves Orkestr can create the thread, prepare the desktop profile, and queue work. The real-agent follow-up requires the user's local Codex login and terminal runtime.
