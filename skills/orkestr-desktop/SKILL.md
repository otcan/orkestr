---
name: orkestr-desktop
description: Use when an Orkestr user sends /desktop, /browser, asks for a mobile or phone desktop link, or pastes an Orkestr desktop challenge for approval.
---

# Orkestr Desktop

Handle mobile desktop access from inside the Codex agent. Do not expect the
Orkestr message router to intercept `/desktop`.

## Workflow

1. Discover context with `orkestr whereiam --json`.
2. If the user named a desktop slug, use it. Otherwise use the manual
   intervention desktop from the context, then the default desktop.
3. Create a phone link:

   ```bash
   orkestr desktop share [slug]
   ```

4. Send the generated URL back to the user and ask them to open it, copy the
   displayed `desk-...` challenge, and paste it into chat.
5. When the user pastes a `desk-...` challenge, approve it:

   ```bash
   orkestr desktop approve <challenge-id>
   ```

6. Tell the user to return to the opened desktop page.

Use Orkestr APIs and CLI helpers only. Do not read browser profiles, connector
tokens, cookies, or files under `ORKESTR_HOME/secrets` directly.
