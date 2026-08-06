# Twilio Voice Assistant

Orkestr supports three inbound Twilio voice modes:

- `twilio_native`: Twilio speech gather creates an owner-visible message draft.
- `calle_callback`: Twilio answers quickly, then Orkestr starts one outbound CALL-E callback.
- `calle_live`: reserved for a real CALL-E Twilio Media Streams, SIP, or WebSocket gateway.

`calle_live` is fail-closed unless a real `wss://` CALL-E live gateway URL is configured.

## Callback Readiness

`calle_callback` must not be treated as ready just because the code supports it. It is ready only when operator configuration is complete:

- webhook token configured
- public base URL configured
- summary destination configured
- Twilio signature auth token configured
- Twilio number webhook points to the expected incoming URL
- CALL-E CLI auth/reachability verified on the host

Without the Twilio signature auth token, callback mode fails closed. Orkestr returns unavailable TwiML and does not start an outbound CALL-E callback.

Check readiness without printing secrets:

```bash
node scripts/twilio-voice-assistant.mjs status --json
```

The output separates code support from operator configuration under `readiness.code`, `readiness.operatorConfig`, and `readiness.blockers`.

## Safe Configuration

Store configuration through secure secrets:

```bash
node scripts/twilio-voice-assistant.mjs configure-secrets \
  --summary-to owner@example.test \
  --public-url https://voice.example.test \
  --mode calle-callback \
  --assistant-label "Example Owner phone assistant" \
  --twilio-auth-token "<twilio-account-auth-token>"
```

Do not point a Twilio number at callback mode until `status --json` has no readiness blockers. The number configuration commands refuse `calle_callback` when signature auth is missing.

## Smoke Test

Only run a real inbound call smoke test during an attended operation window. A valid smoke confirms:

- Twilio answers quickly.
- One normal caller gets exactly one CALL-E callback.
- Anonymous, unknown, or restricted caller ID falls back to native speech capture.
- Owner-visible summary or failure notification includes caller, called line, CallSid, phase/error, and recovery.
- No duplicate callback starts for Twilio retries or restart recovery.
