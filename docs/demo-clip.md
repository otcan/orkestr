# Public Demo Clip

This is the recording manifest for a 60-90 second Orkestr public-safe demo.
Use disposable state only.

## Clip Contract

- Runtime: fresh local checkout or disposable VM.
- Data: fake thread names, fake prompts, fake local paths.
- Credentials: no real WhatsApp, Gmail, LinkedIn, browser profile, token, or
  private overlay state visible.
- Visuals: README positioning, `/setup`, one thread/status view, and terminal
  proof from `npm run demo:coding-agent`.

## Recording Steps

1. Open the README at the top and show:
   - Orkestr as the local-first workstation.
   - oXRM as the first workflow app.
   - Security model: do not expose raw routes publicly.
2. Open `http://127.0.0.1:19812/setup` from a disposable local run.
3. Show a fake `demo-coding-agent` thread with status/history.
4. Show CLI proof:

```bash
npm run demo:coding-agent
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
| 0-10s | README first viewport | Product split and local-first stance. |
| 10-25s | `/setup` | Show setup route only; no real credentials. |
| 25-45s | Thread/status view | Use fake `demo-coding-agent` state. |
| 45-70s | Terminal demo command | Show `Coding-agent demo passed`. |
| 70-90s | Orkestr/oXRM bridge | Explain workstation plus workflow app. |

## Publish Checklist

- No phone numbers.
- No personal chat names.
- No Gmail, LinkedIn, or browser session data.
- No `.env`, token, secret manager, private hostname, or overlay path.
- No real customer/project data.
- File named with date, for example `orkestr-public-demo-2026-06-17.mp4`.
- Link the uploaded clip from the GitHub release or README only after review.

