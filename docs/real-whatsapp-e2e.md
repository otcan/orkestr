# Real WhatsApp E2E

`npm run e2e:whatsapp-real` runs an opt-in live acceptance test for a
WhatsApp-bound Orkestr thread. It sends a real message through a configured
sender WhatsApp account, verifies that the responder account sees and routes the
message, checks that the assistant reply is visible in WhatsApp history, and
exercises desktop lease/share and timer watcher APIs.

The test is disabled by default. It requires `--execute` and explicit live
targets because it sends real WhatsApp messages.

```bash
npm run e2e:whatsapp-real -- --execute \
  --api-base http://127.0.0.1:19812 \
  --orkestr-home /path/to/orkestr-home \
  --thread onboarding-thread-id \
  --chat-id whatsapp-group-id@g.us \
  --sender-account sender \
  --responder-account responder \
  --desktop gmail
```

Useful release modes:

- Add `--no-desktop` when a release target has no managed desktops.
- Add `--no-timer` when only WhatsApp transport and OAuth-link creation should
  be checked.
- Add `--open-link-in-desktop` to open the generated Google connection link in
  the managed desktop.
- Add `--require-oauth-callback` only for attended runs where a human/operator
  will complete Google OAuth before the timeout.
- Add `--artifact artifacts/real-wa-e2e.json` to keep a machine-readable result.

The default run validates the Google Workspace connect page but does not consume
the one-time OAuth link. For attended Gmail approval, use the generated link or
managed desktop share from the JSON output, complete Google OAuth, then rerun
with `--require-oauth-callback` if callback verification is required.
