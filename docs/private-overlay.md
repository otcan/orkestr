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

Minimum overlay file:

```json
{
  "name": "Private Orkestr",
  "connectors": {},
  "agents": [],
  "timers": []
}
```

The overlay is runtime input. Public code should add generic extension points when private use cases need new behavior.
