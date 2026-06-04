# Public KubeVirt Rollout

This is the public-beta deployment shape for `orkestr.example.test`. The public app must
run inside the `orkestr-public` k3s/KubeVirt VM, not as a host-level process sharing
the personal/dev Orkestr runtime.

## Hosts

- `orkestr.example.test`: public landing page or redirect target.
- `app.orkestr.example.test`: Orkestr application.
- `auth.orkestr.example.test`: browser pairing, login, and challenge approval surface.

## DNS

Point these records at the dedicated VPS public IPv4 address:

```text
A     @     <vps-ip>
A     app   <vps-ip>
A     auth  <vps-ip>
CNAME www   orkestr.example.test
```

Keep DNS provider credentials and API keys outside the OSS repository.

## Runtime boundary

- Personal/dev Orkestr stays on the operator host at
  `<operator-app-url>`.
- Public Orkestr runs in namespace `orkestr-public`, VM `orkestr-public`, Service
  `orkestr-public-app:19812`.
- Caddy routes `orkestr.example.test`, `app.orkestr.example.test`, and `auth.orkestr.example.test` to the
  Kubernetes Service, not to host `127.0.0.1:19812`.
- Public `ORKESTR_HOME` lives inside the VM, normally `/opt/orkestr/data`.
- Public rollout is an exact Orkestr release inside the VM with
  `ORKESTR_HOME=/opt/orkestr/data orkestr update --release --ref <ref> --channel public --allow-interrupt
  --no-smoke`. The public VM is isolated from personal/dev work, and the generic
  local smoke plus active-thread HTTP check are skipped because the public app
  intentionally protects private API routes with browser pairing. Use the public
  KubeVirt and public-domain smokes instead.
- Public Gmail, Outlook, Jira, Shopify, browser, WhatsApp, and runtime secrets
  must be VM-local. Do not mount or copy personal `<operator-orkestr-home>`,
  `<operator-codex-home>`, PA browser profiles, private overlays, or host WhatsApp
  session state.

## Fresh VM bootstrap

On a fresh Ubuntu 24.04 VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- \
  --domain orkestr.example.test \
  --app-host app.orkestr.example.test \
  --auth-host auth.orkestr.example.test \
  --email admin@example.com \
  --with-whatsapp \
  --track-main
```

The bootstrap writes:

```text
ORKESTR_PRIMARY_DOMAIN=orkestr.example.test
ORKESTR_PUBLIC_SITE_URL=https://orkestr.example.test
ORKESTR_APP_HOST=app.orkestr.example.test
ORKESTR_AUTH_HOST=auth.orkestr.example.test
ORKESTR_PUBLIC_URL=https://app.orkestr.example.test
ORKESTR_AUTH_URL=https://auth.orkestr.example.test
ORKESTR_COOKIE_DOMAIN=orkestr.example.test
ORKESTR_PUBLIC_HTTPS_URL=https://app.orkestr.example.test
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

### Endpoint Recovery Check

The public VM can report `VMI Running` while the `virt-launcher` pod is in
`Error` and the `orkestr-public-app` Service has no endpoints. Treat that as an
unhealthy public instance even if the VMI status looks ready.

Run:

```bash
bash scripts/migrate-public-kubevirt.sh status
bash scripts/migrate-public-kubevirt.sh smoke
```

The smoke now fails before app health if:

- namespace `orkestr-public` / VMI `orkestr-public` is not Ready
- the `virt-launcher` pod is not serving
- Service `orkestr-public-app` has no ready EndpointSlice addresses

Recovery order:

1. Keep the personal ops instance untouched.
2. If Caddy is already routed to the VM and public health is failing, either fix
   the VM immediately or roll back the public Caddy upstream.
3. Restart the public VM only:

   ```bash
   KUBECONFIG=/etc/rancher/k3s/k3s.yaml virtctl restart --namespace orkestr-public orkestr-public
   ```

4. Wait for `bash scripts/migrate-public-kubevirt.sh smoke` to pass.
5. Only then route or keep routing WhatsApp/OAuth/challenge traffic to the
   public instance.

The helper:

- creates a dedicated operator key if VM SSH access is missing
- backs up `<host-public-orkestr-home>`
- copies only public instance state into the VM
- refuses to pass smoke if unauthenticated attach stops returning
  `browser_pairing_required`
- checks that the VM cannot see known personal host paths or host container
  sockets
- verifies the VM-local operator attach path when a Codex-backed thread is
  available, and records a skip when the public VM has no Codex login because
  public coding execution is out of scope
- switches Caddy to the VM Service and disables `orkestr-public.service`

## Operator access

Operator CLI actions are VM-local:

```bash
pod_ip="$(kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml \
  get pod -n orkestr-public -l kubevirt.io/domain=orkestr-public \
  -o jsonpath='{.items[0].status.podIP}')"

ssh -i "$HOME/.ssh/orkestr-public-operator" orkestr@"$pod_ip" \
  'ORKESTR_HOME=/opt/orkestr/data ORKESTR_API_BASE=http://127.0.0.1:19812 orkestr list'

ssh -i "$HOME/.ssh/orkestr-public-operator" orkestr@"$pod_ip" \
  'ORKESTR_HOME=/opt/orkestr/data ORKESTR_API_BASE=http://127.0.0.1:19812 orkestr attach --print <thread>'
```

External unauthenticated attach requests must continue to fail with
`browser_pairing_required`. If the public VM has no Codex login, VM-local
`attach --print` may report `Codex is not signed in`; that confirms the request
reached the local operator path rather than browser-pairing auth.

## Public WhatsApp router with parent runtime delegation

For migration periods where public Orkestr owns WhatsApp routing but existing
personal/dev Codex threads remain the execution backend, use two private parent
proxies:

- WhatsApp transport proxy: exposes the already-paired parent WhatsApp Web
  account to the public VM. This keeps the current login/session and avoids QR
  reauth.
- Parent runtime proxy: exposes only the narrow runtime API needed by the
  public router: thread input, thread messages, thread history, runtime status,
  and interrupt. Use `scripts/parent-runtime-proxy.mjs` as the implementation.

The parent runtime proxy is configured with secrets outside the repo:

```text
ORKESTR_PARENT_RUNTIME_PROXY_LISTEN_HOST=<operator-proxy-ip>
ORKESTR_PARENT_RUNTIME_PROXY_PORT=18914
ORKESTR_PARENT_RUNTIME_PROXY_UPSTREAM=http://127.0.0.1:<parent-api-port>
ORKESTR_PARENT_RUNTIME_PROXY_TOKEN=<token accepted from public VM>
ORKESTR_PARENT_RUNTIME_PROXY_CLI_AUTH_FILE=<parent ORKESTR_HOME>/secrets/cli-auth.json
```

The public VM points delegated thread bindings at that proxy:

```text
ORKESTR_REMOTE_THREAD_BACKENDS_JSON={
  "personal": {
    "baseUrl": "http://<operator-proxy-ip>:18914",
    "token": "<token accepted by parent runtime proxy>"
  }
}
```

Each public WhatsApp-bound thread that delegates to the parent runtime stores:

```json
{
  "connector": "whatsapp",
  "chatId": "<wa-chat-id>",
  "responderAccountId": "<public-responder-account>",
  "remoteBackend": "personal",
  "remoteThreadId": "<parent-thread-id>",
  "remoteRuntimeEnabled": true,
  "remoteMirrorEnabled": true
}
```

During cutover:

- Public Orkestr receives inbound WhatsApp, records the public user message, and
  forwards the same input to the parent runtime.
- Public Orkestr imports parent messages and sends queue notices, progress, final
  replies, and failures through the public WhatsApp bridge.
- Personal/dev Orkestr must not mirror migrated chats directly. Set the parent
  binding `mirrorToWhatsApp=false` or remove the parent WhatsApp binding after
  the public route is active.
- Do not copy parent WhatsApp session state, Gmail tokens, browser profiles, or
  Codex homes into the public VM. Only proxy the authenticated transport/runtime
  surfaces through the allowlisted private endpoints.

## Verification

Run:

```bash
bash scripts/smoke-public-domain.sh --domain app.orkestr.example.test --host <vps-ip> --ssh root@<vps-ip>
bash scripts/migrate-public-kubevirt.sh smoke
```

Then verify manually:

- `https://app.orkestr.example.test` redirects unpaired browsers into the pairing flow on
  `https://auth.orkestr.example.test`.
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
