# Security

Orkestr is public alpha, single-user software. It can wake local terminal sessions, deliver text into Codex, open browser profiles, and store connector configuration under `ORKESTR_HOME`.

## Safe Defaults

- Bind to localhost: `ORKESTR_HOST=127.0.0.1`.
- Keep `ORKESTR_HOME` outside the repository.
- Keep `ORKESTR_OVERLAY_DIR` private.
- Do not expose `/api/*`, thread streams, terminal routes, or browser controls directly to the internet.
- Use a private network such as Tailscale before remote access.
- Put Caddy or another trusted reverse proxy in front before enabling HTTPS access from another machine.

## Remote Access

Recommended order:

1. Run Orkestr on `127.0.0.1:19812`.
2. Join the host to a private tailnet.
3. Put Caddy in front of Orkestr.
4. Use a tailnet HTTPS name or a public domain that you control.
5. Add an auth boundary before exposing browser or terminal controls.

The `/setup` Secure Access step reports the current bind address, Caddy availability, Tailscale/HTTPS hints, and browser pairing state.

Set `ORKESTR_AUTH_REQUIRED=1` to require browser pairing before protected API access. The host-native VPS installer enables this by default in `/etc/orkestr/orkestr.env`. An unpaired browser can only generate a pairing challenge and poll that challenge. Approve the challenge from trusted host access:

```bash
ssh root@YOUR_SERVER
orkestr security approve CHALLENGE_ID
```

`root` is the default in these instructions because fresh VPS images usually reserve service, install, and firewall control for root. Hardened installs can use a sudo-capable deploy user and run `sudo orkestr security approve CHALLENGE_ID` instead. After approval, Orkestr sets a `HttpOnly`, `SameSite=Lax` session cookie. Use `ORKESTR_COOKIE_SECURE=1` when serving through HTTPS.

## Secrets

Never commit:

- OpenAI keys
- Gmail OAuth secrets or refresh tokens
- WhatsApp Web session state
- browser profile directories
- real chat IDs
- private hostnames
- VPS deploy keys, known-host material, or tailnet OAuth secrets
- personal prompts and schedules

If a value cannot be published to the public internet, it does not belong in this repository.

## Reporting Vulnerabilities

Please do not open public issues for vulnerabilities that include secrets or exploit details. Report with a minimal description and reproduction using fake data. If a private contact channel has not been published yet, open a public issue that says "security report contact needed" without sensitive details.
