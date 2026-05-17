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
Next real-agent step: open `/setup`, complete Codex sign-in, then wake the demo thread.
```

## Real-Agent Follow-Up

Use the web cockpit to open the demo thread, press **Wake**, then open the raw
terminal panel if you want to inspect the live Codex session. Host-native
contributors can still use `npx orkestr-oss wake demo-coding-agent`.

The public dry run proves Orkestr can create the thread, prepare the desktop
profile, and queue work. The Docker runtime includes Codex; the real-agent
follow-up requires completing Codex device authorization from the setup page.
