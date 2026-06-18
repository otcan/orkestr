# Real WhatsApp E2E

Use the real WhatsApp E2E procedure in
[LLM-assisted release procedures](llm-assisted-release-procedures.md) before
running live transport checks. The procedure owns preflight, target validation,
failure classification, retry decisions, and the public-safe evidence packet.

`npm run e2e:whatsapp-real` is the command primitive for the opt-in live
acceptance test for a WhatsApp-bound Orkestr thread. In the default automated
mode it injects inbound test messages into the responder account, using the
bound sender contact identity for attribution. This keeps the sender account
isolated while verifying responder-side routing, assistant reply delivery,
desktop share challenge approval, and timer watcher APIs. Use `--real-send`
only when the release requires a live sender-account transport check.

The test is disabled by default. It requires `--execute` and explicit targets.
Default automated mode uses the local bridge injection endpoint; `--real-send`
and `--manual-send` send real WhatsApp messages.

Use a dedicated test/onboarding/release-smoke WhatsApp binding. The preflight
fails before leasing desktops or routing messages when the binding is disabled,
not route eligible, or looks like a normal production/project chat. Passing
`--allow-production-binding` is an explicit escape hatch for attended emergency
runs only.

Do not use a skill-only WhatsApp account as a routed responder account. A
skill-only account may be used for attended side checks, but it must stay out of
Orkestr router bindings and release readiness gates. See
[WhatsApp Account Operations](whatsapp-account-operations.md).

For the private VM demo acceptance path, use
`npm run e2e:whatsapp-demo-onboarding`. That test is intentionally
Orkestr-initiated: it sends the first message from the serving/responder
WhatsApp account to the target direct chat and verifies the outbound prompt asks
the user to complete Codex login/sign-in in setup. For demo-review runs, pass a
stable public connect base URL such as `https://connect.orkestr.de`; the runner
registers a fresh broker instance and sends
`https://connect.orkestr.de/i/<fresh-broker-uuid>/setup`.
If no public setup URL is provided, the script can still create a temporary
Cloudflare quick tunnel for local fallback testing when
`ORKESTR_DEMO_CLOUDFLARE_FALLBACK=1` is set, but that path is not the
preferred mobile demo path. It does not depend on the user sending
`/connect google`.

```bash
npm run e2e:whatsapp-demo-onboarding -- --execute \
  --api-base http://127.0.0.1:19812 \
  --orkestr-home /path/to/orkestr-home \
  --phone +4917600000000 \
  --responder-account responder \
  --artifact artifacts/real-wa-demo-onboarding.json
```

```bash
npm run e2e:whatsapp-real -- --execute \
  --api-base http://127.0.0.1:19812 \
  --orkestr-home /path/to/orkestr-home \
  --thread onboarding-thread-id \
  --chat-id whatsapp-group-id@g.us \
  --responder-account responder \
  --desktop gmail
```

The runner preflights WhatsApp account readiness before it leases a desktop or
routes a message. Default injected mode requires only `--responder-account` to
resolve to a ready WhatsApp account. If `--sender-account` is present, it is
recorded as an observed isolation subject but it is not used to queue test
messages. `--real-send` switches to live sender-account transport; in that mode
both `--sender-account` and `--responder-account` must resolve to ready WhatsApp
accounts. If the sender is not paired in `--real-send` mode, the run fails early
with `sender_account_not_ready` and writes the account state into the JSON
artifact.

In attended mode, the sender is a WhatsApp contact in the thread binding, not a
second bridge session. The runner resolves the binding and discovers authorized
sender contacts such as `+491...` or `491...@c.us`. Use `--sender-contact` to
pin the expected contact; otherwise the runner uses the binding's authorized
sender list.

Useful release modes:

- Add `--no-desktop` when a release target has no managed desktops.
- Add `--no-desktop-challenge` when the target can lease desktops but the public
  share URL is intentionally unreachable from the runner.
- Add `--no-timer` when only WhatsApp transport and OAuth-link creation should
  be checked.
- Add `--manual-send` for attended real-message checks when the test operator
  will send `/connect google` from a real phone/contact in the target WhatsApp
  chat. This still uses real WhatsApp transport and does not call the bridge
  injection endpoint, but it cannot run unattended in CI.
- Add `--real-send` when automated release evidence must prove that a separate
  paired sender account can send over live WhatsApp transport. Without this
  flag, automated runs inject inbound messages into the responder account.
- Add `--sender-contact <contact-id>` when the target chat has multiple allowed
  people and the test should accept only one real sender.
- Add `--open-link-in-desktop` to open the generated Google connection link in
  the managed desktop.
- Add `--allow-production-binding` only when the operator intentionally accepts
  running release E2E traffic against a normal project binding.
- Add `--require-oauth-callback` only for attended runs where a human/operator
  will complete Google OAuth before the timeout.
- Add `--artifact artifacts/real-wa-e2e.json` to keep a machine-readable result.

The default run validates the Google Workspace connect page but does not consume
the one-time OAuth link. For attended Gmail approval, use the generated link or
managed desktop share from the JSON output, complete Google OAuth, then rerun
with `--require-oauth-callback` if callback verification is required.

When desktop checks are enabled, the runner also opens the generated public
desktop-share URL, obtains the `orkestr desktop approve desk-...` challenge,
injects that challenge into the responder account in default automated mode, and
verifies that the share status exposes an approved desktop URL. In `--real-send`
mode it sends the challenge through the sender account and waits for responder
history. In `--manual-send` mode the runner prints the approval command and
waits for an authorized person in the chat to send it.

Attended public-VM example:

```bash
npm run e2e:whatsapp-real -- --execute \
  --api-base http://127.0.0.1:19812 \
  --orkestr-home /path/to/orkestr-home \
  --thread onboarding-thread-id \
  --chat-id whatsapp-group-id@g.us \
  --responder-account responder \
  --sender-contact +4917600000000 \
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
