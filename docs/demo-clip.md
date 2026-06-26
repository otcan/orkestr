# Public Demo Clip

This is the recording manifest for the Orkestr and oXRM public-safe desktop
demo. Use disposable state only.

## Recorded Asset

- Video: [docs/assets/orkestr-oxrm-live-demo.mp4](assets/orkestr-oxrm-live-demo.mp4)
- Poster: [docs/assets/orkestr-oxrm-live-demo.poster.png](assets/orkestr-oxrm-live-demo.poster.png)
- Duration: 82 seconds.
- Frame: 1600x900 at 30 fps.
- Reproduce:

```bash
npm run demo:record:live
```

The recording script starts a temporary Orkestr home, disables external
connector launches, opens a disposable X desktop, captures Chrome with ffmpeg,
and uses the running oXRM demo stack for the relationship-workspace segment.

## Clip Contract

- Runtime: fresh local checkout, disposable desktop, or disposable VM.
- Data: fake thread names, fake prompts, synthetic oXRM records, fake local
  paths.
- Credentials: no real WhatsApp, Gmail, LinkedIn, browser profile, token, or
  private overlay state visible.
- Visuals: positioning frame, `/setup`, one thread/status view, oXRM dashboard,
  and terminal proof from `npm run demo:coding-agent` plus MCP reads.

## Recording Steps

1. Show the positioning frame:
   - Orkestr as the local-first workstation.
   - oXRM as the first MCP-first workflow app.
   - No real accounts, tokens, chats, or private overlays.
2. Open `/setup` from a disposable local Orkestr run.
3. Show a fake `demo-coding-agent` thread with queued state.
4. Show the oXRM Docker dashboard with synthetic demo data.
5. Show CLI proof:

```bash
npm run demo:coding-agent
./oxrm cli mcp:read crm://queue/today
./oxrm cli mcp:call crm.search_leads --input '{"query":"Alex"}'
```

Expected visible line:

```text
Coding-agent demo passed
```

5. End on the existing public-safe visual:

```text
docs/assets/orkestr-three-screen-demo.png
```

## Shot List

| Time | Shot | Notes |
| --- | --- | --- |
| 0-10s | Positioning frame | Product split and local-first stance. |
| 10-25s | `/setup` | Show setup route only; no real credentials. |
| 25-45s | Thread/status view | Use fake `demo-coding-agent` state. |
| 45-60s | oXRM dashboard | Show synthetic relationship-workspace state. |
| 60-82s | Terminal demo commands | Show `Coding-agent demo passed` and MCP output. |

## Publish Checklist

- No phone numbers.
- No personal chat names.
- No Gmail, LinkedIn, or browser session data.
- No `.env`, token, secret manager, private hostname, or overlay path.
- No real customer/project data.
- File committed as `docs/assets/orkestr-oxrm-live-demo.mp4`.
- Link the clip from the GitHub release or README only after review.
