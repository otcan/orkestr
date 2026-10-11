# WhatsApp onboarding modes

The setup status API includes a small, safe `whatsappOnboarding` projection:

```json
{
  "availableModes": ["self_hosted"],
  "selectedMode": "self_hosted",
  "health": "not_connected",
  "pairingState": "not_started"
}
```

Self-hosted WhatsApp is the default. Pairing uses the built-in local bridge and
stores its session in the instance's configured data volume, outside this
repository. A managed mode is advertised only when the server has an external
WhatsApp bridge configured. The browser cannot make a managed relay available
by selecting it; an unavailable mode is rejected by the setup API.

The projection is limited to fixed status enums and mode names. It never
contains bridge endpoints, tokens, phone numbers, account IDs, QR payloads,
pairing codes, or provider error details. Existing connector APIs remain the
authority for starting, inspecting, and stopping a local pairing session.
