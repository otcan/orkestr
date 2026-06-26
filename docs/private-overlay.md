# Private Overlay

The public Orkestr repo is generic product code. Real operational configuration belongs in a private overlay directory.

Start Orkestr with:

```bash
ORKESTR_OVERLAY_DIR=/path/to/private-overlay npm start
```

The public repo may contain fake examples under `examples/`. It must not contain:

- real WhatsApp IDs
- private hostnames
- browser profiles
- OAuth tokens or client secrets
- business-specific prompts
- personal timers
- deployment files for a private host
- skill-only WhatsApp account sessions, tokens, pairing codes, and phone numbers

Minimum overlay file:

```json
{
  "name": "Private Orkestr",
  "connectors": {},
  "executors": {
    "default": "noop",
    "modules": []
  },
  "agents": [],
  "timers": []
}
```

The overlay is runtime input. Public code should add generic extension points when private use cases need new behavior.

WhatsApp deployments that use more than one phone/account should keep the
routed account configuration in private env or secret-manager state and keep
skill-only account state outside `ORKESTR_WHATSAPP_ACCOUNT_IDS`. See
[WhatsApp Account Operations](whatsapp-account-operations.md).
