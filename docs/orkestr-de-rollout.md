# orkestr.de rollout

This is the public-beta deployment shape for a dedicated Orkestr instance using
operator-controlled infrastructure.

## Hosts

- `orkestr.de`: public landing page or redirect target.
- `app.orkestr.de`: Orkestr application.
- `auth.orkestr.de`: browser pairing, login, and challenge approval surface.

## DNS

Point these records at the dedicated VPS public IPv4 address:

```text
A     @     <vps-ip>
A     app   <vps-ip>
A     auth  <vps-ip>
CNAME www   orkestr.de
```

Keep DNS provider credentials and API keys outside the OSS repository.

## Bootstrap

On a fresh Ubuntu 24.04 VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- \
  --domain orkestr.de \
  --app-host app.orkestr.de \
  --auth-host auth.orkestr.de \
  --email admin@example.com \
  --with-whatsapp \
  --track-main
```

The bootstrap writes:

```text
ORKESTR_PRIMARY_DOMAIN=orkestr.de
ORKESTR_PUBLIC_SITE_URL=https://orkestr.de
ORKESTR_APP_HOST=app.orkestr.de
ORKESTR_AUTH_HOST=auth.orkestr.de
ORKESTR_PUBLIC_URL=https://app.orkestr.de
ORKESTR_AUTH_URL=https://auth.orkestr.de
ORKESTR_COOKIE_DOMAIN=orkestr.de
ORKESTR_PUBLIC_HTTPS_URL=https://app.orkestr.de
```

## Verification

Run:

```bash
bash scripts/smoke-public-domain.sh --domain app.orkestr.de --host <vps-ip> --ssh root@<vps-ip>
```

Then verify manually:

- `https://app.orkestr.de` redirects unpaired browsers into the pairing flow on
  `https://auth.orkestr.de`.
- Approving the challenge from SSH pairs the browser and returns to the app.
- Creating a test thread produces a Codex final answer.
- WhatsApp inbound messages, working status, final answers, and error messages
  route to the expected user/thread only.
