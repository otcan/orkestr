# Twilio Voice Assistant

Orkestr supports three inbound Twilio voice modes:

- `twilio_native`: Twilio speech gather creates an owner-visible message draft.
- `calle_callback`: Twilio answers quickly, then Orkestr starts one outbound CALL-E callback.
- `calle_live`: reserved for a real CALL-E Twilio Media Streams, SIP, or WebSocket gateway.

`calle_live` is fail-closed unless a real `wss://` CALL-E live gateway URL is configured.

## Callback Readiness

`calle_callback` must not be treated as ready just because the code supports it. Orkestr reports two separate states:

- static configuration: all local settings needed to accept a signed Twilio webhook and start CALL-E are present
- operational readiness: the Twilio number webhook, Twilio signature validation, and CALL-E auth/reachability have been verified during an attended check

Static callback configuration requires:

- webhook token configured
- public base URL configured
- summary destination configured
- Twilio signature auth token configured
- explicit CALL-E callback goal configured

Operational readiness additionally requires:

- Twilio number webhook points to the expected incoming URL
- Twilio signature validation has been verified with a real Twilio request
- CALL-E CLI auth/reachability verified on the host

Without the Twilio signature auth token or explicit CALL-E goal, callback mode fails closed. Orkestr returns unavailable TwiML and does not start an outbound CALL-E callback.

Check readiness without printing secrets:

```bash
node scripts/twilio-voice-assistant.mjs status --json
```

The output separates code support, static operator configuration, and unchecked live verification under `readiness.code`, `readiness.operatorConfig`, `readiness.verification`, `readiness.staticBlockers`, and `readiness.operationalBlockers`. `ok: true` only means static configuration has no blockers. `readiness.ready: true` means static configuration and required operational verification are both complete.

## Safe Configuration

Store configuration through secure secrets:

```bash
node scripts/twilio-voice-assistant.mjs configure-secrets \
  --summary-to owner@example.test \
  --public-url https://voice.example.test \
  --mode calle-callback \
  --assistant-label "Example Owner phone assistant" \
  --twilio-auth-token "<twilio-account-auth-token>" \
  --calle-goal "Call the caller back, ask why they called, and summarize the next action."
```

Do not point a Twilio number at callback mode until `status --json` has no static blockers and the operational checks have been run during an attended window. The number configuration commands refuse `calle_callback` when signature auth or the explicit CALL-E goal is missing.

## Smoke Test

Only run a real inbound call smoke test during an attended operation window. A valid smoke confirms:

- Twilio answers quickly.
- One normal caller gets exactly one CALL-E callback.
- Anonymous, unknown, or restricted caller ID falls back to native speech capture.
- Owner-visible summary or failure notification includes caller, called line, CallSid, phase/error, and recovery.
- No duplicate callback starts for Twilio retries or restart recovery.
