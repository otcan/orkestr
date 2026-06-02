# orkestr.de KubeVirt rollout

This is the public-beta deployment shape for `orkestr.de`. The public app must
run inside the `orkestr-de` k3s/KubeVirt VM, not as a host-level process sharing
the personal/dev Orkestr runtime.

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

## Runtime boundary

- Personal/dev Orkestr stays on the operator host at
  `https://orkestr.app.ops.oguzcanunver.com`.
- Public Orkestr runs in namespace `orkestr-de`, VM `orkestr-de`, Service
  `orkestr-de-app:19812`.
- Caddy routes `orkestr.de`, `app.orkestr.de`, and `auth.orkestr.de` to the
  Kubernetes Service, not to host `127.0.0.1:19812`.
- Public `ORKESTR_HOME` lives inside the VM, normally `/opt/orkestr/data`.
- Public rollout is an exact Orkestr release inside the VM with
  `ORKESTR_HOME=/opt/orkestr/data orkestr update --release --ref <ref> --channel orkestr-de --allow-interrupt
  --no-smoke`. The public VM is isolated from personal/dev work, and the generic
  local smoke plus active-thread HTTP check are skipped because the public app
  intentionally protects private API routes with browser pairing. Use the public
  KubeVirt and public-domain smokes instead.
- Public Gmail, Outlook, Jira, Shopify, browser, WhatsApp, and runtime secrets
  must be VM-local. Do not mount or copy personal `/home/openclaw/.orkestr-production`,
  `/root/.codex`, PA browser profiles, private overlays, or host WhatsApp
  session state.

## Fresh VM bootstrap

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

For the existing public VM, use the migration helper instead of re-running the
fresh bootstrap from the host.

## Migration and cutover

Run from the repo root on the k3s host:

```bash
bash scripts/migrate-public-kubevirt.sh status
bash scripts/migrate-public-kubevirt.sh ensure-ssh
bash scripts/migrate-public-kubevirt.sh update-vm --ref <tag-or-commit>
bash scripts/migrate-public-kubevirt.sh backup-vm-state
bash scripts/migrate-public-kubevirt.sh copy-public-state
bash scripts/migrate-public-kubevirt.sh smoke
bash scripts/migrate-public-kubevirt.sh cutover
```

The helper:

- creates a dedicated operator key if VM SSH access is missing
- backs up `/home/openclaw/.orkestr-public`
- copies only public instance state into the VM
- refuses to pass smoke if unauthenticated attach stops returning
  `browser_pairing_required`
- checks that the VM cannot see known personal host paths or host container
  sockets
- switches Caddy to the VM Service and disables `orkestr-public.service`

## Operator access

Operator CLI actions are VM-local:

```bash
pod_ip="$(kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml \
  get pod -n orkestr-de -l kubevirt.io/domain=orkestr-de \
  -o jsonpath='{.items[0].status.podIP}')"

ssh -i /root/.ssh/orkestr-de-operator orkestr@"$pod_ip" \
  'ORKESTR_HOME=/opt/orkestr/data ORKESTR_API_BASE=http://127.0.0.1:19812 orkestr list'

ssh -i /root/.ssh/orkestr-de-operator orkestr@"$pod_ip" \
  'ORKESTR_HOME=/opt/orkestr/data ORKESTR_API_BASE=http://127.0.0.1:19812 orkestr attach --print <thread>'
```

External unauthenticated attach requests must continue to fail with
`browser_pairing_required`.

## Verification

Run:

```bash
bash scripts/smoke-public-domain.sh --domain app.orkestr.de --host <vps-ip> --ssh root@<vps-ip>
bash scripts/migrate-public-kubevirt.sh smoke
```

Then verify manually:

- `https://app.orkestr.de` redirects unpaired browsers into the pairing flow on
  `https://auth.orkestr.de`.
- Approving the challenge from SSH pairs the browser and returns to the app.
- Creating a test thread produces a Codex final answer.
- WhatsApp inbound messages, working status, final answers, and error messages
  route to the expected public user/thread only, if public WhatsApp is enabled.
- Personal/dev Orkestr health, WhatsApp routing, workers, and PA/browser desks
  remain unchanged.

## Rollback

If cutover fails after Caddy reload:

```bash
bash scripts/migrate-public-kubevirt.sh rollback
```

Rollback re-enables `orkestr-public.service`, points Caddy back to
`127.0.0.1:19812`, reloads Caddy, and verifies host public health.
