# Real WhatsApp E2E

`npm run e2e:whatsapp-real` runs an opt-in live acceptance test for a
WhatsApp-bound Orkestr thread. In the automated mode it sends a real message
through a configured sender WhatsApp account, verifies that the responder
account sees and routes the message, checks that the assistant reply is visible
in WhatsApp history, and exercises desktop lease/share and timer watcher APIs.

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

The runner preflights WhatsApp account readiness before it leases a desktop or
sends a message. Automated mode requires both `--sender-account` and
`--responder-account` to resolve to ready WhatsApp accounts. If the sender is not
paired, the run fails early with `sender_account_not_ready` and writes the
account state into the JSON artifact.

Useful release modes:

- Add `--no-desktop` when a release target has no managed desktops.
- Add `--no-timer` when only WhatsApp transport and OAuth-link creation should
  be checked.
- Add `--manual-send` for attended real-message checks when the test operator
  will send `/connect google` from a real phone/contact in the target WhatsApp
  chat. This still uses real WhatsApp transport and does not call the bridge
  injection endpoint, but it cannot run unattended in CI.
- Add `--open-link-in-desktop` to open the generated Google connection link in
  the managed desktop.
- Add `--require-oauth-callback` only for attended runs where a human/operator
  will complete Google OAuth before the timeout.
- Add `--artifact artifacts/real-wa-e2e.json` to keep a machine-readable result.

The default run validates the Google Workspace connect page but does not consume
the one-time OAuth link. For attended Gmail approval, use the generated link or
managed desktop share from the JSON output, complete Google OAuth, then rerun
with `--require-oauth-callback` if callback verification is required.

Attended public-VM example:

```bash
npm run e2e:whatsapp-real -- --execute \
  --api-base http://127.0.0.1:19812 \
  --orkestr-home /path/to/orkestr-home \
  --thread onboarding-thread-id \
  --chat-id whatsapp-group-id@g.us \
  --responder-account responder \
  --desktop gmail \
  --manual-send \
  --artifact artifacts/real-wa-e2e.json
```

When the command prints the manual instruction, send this exact message in the
target WhatsApp chat from an authorized real phone/contact:

```text
/connect google
```

The runner then waits for the responder account to observe that real message,
for Orkestr to route it into the bound thread, for the Google connection link to
be mirrored back to WhatsApp, and for the timer watcher check to complete.
