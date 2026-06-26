# Orkestr WA Service

The extracted `orkestr-wa` service runs the WhatsApp Web bridge outside the
Orkestr UI/API process. Orkestr instances then use `WHATSAPP_BRIDGE_MODE=external`
and call the service over HTTP.

This keeps WhatsApp browser state out of `orkestr-ui.service` restarts and gives
OSS demo instances a single explicit WhatsApp routing boundary.

## Runtime Contract

Start the service with:

```bash
node scripts/orkestr-wa-service.mjs
```

Service environment:

```bash
ORKESTR_HOME=/var/lib/orkestr-wa
ORKESTR_WA_SERVICE_HOST=127.0.0.1
ORKESTR_WA_SERVICE_PORT=18914
ORKESTR_WA_SERVICE_TOKEN=replace-with-local-secret
ORKESTR_WHATSAPP_ACCOUNT_IDS=sender,responder
ORKESTR_WHATSAPP_AUTOSTART=1
ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=sender,responder
```

For host-native systemd installs, the installer can create the standalone unit
and a separate private env file:

```bash
ORKESTR_INSTALL_WA_SERVICE=1 sudo -E scripts/install.sh --systemd
```

This writes `orkestr-wa.service` by default as `<orkestr-service>-wa.service`,
uses `ORKESTR_WA_SERVICE_HOME` for WhatsApp service state, reads
`ORKESTR_WA_SERVICE_ENV_FILE` for private account/session/policy values, and
points the fresh `orkestr-ui` env at `WHATSAPP_BRIDGE_MODE=external` with local
WhatsApp autostart disabled. Existing env files are preserved and should be
migrated manually.

The service exposes the bridge surface already used by Orkestr external bridge
mode:

- `GET /health`
- `GET /api/dashboard`
- `GET /qr.svg?accountId=<account>`
- `POST /accounts/:account/start`
- `POST /accounts/:account/reconnect`
- `POST /accounts/:account/logout`
- `GET /accounts/:account/chats`
- `GET /accounts/:account/chats/:chat/history`
- `GET /api/chats/:chat/history?accountId=<account>`
- `GET /api/chats/:chat/meta?accountId=<account>`
- `POST /send-text`
- `POST /send-media`
- `POST /chats`

All routes require `Authorization: Bearer <ORKESTR_WA_SERVICE_TOKEN>` unless
`ORKESTR_WA_SERVICE_AUTH_DISABLED=1` is set for local tests.

## Routing Policy

When `ORKESTR_WA_SERVICE_POLICY_JSON` is unset, the service keeps the legacy
single-client behavior and allows authenticated callers to use configured bridge
accounts. For shared host services, set an explicit client policy and have each
Orkestr instance send `X-Orkestr-Instance-Id: <client-id>`.

Example policy with fake identifiers:

```bash
ORKESTR_WA_SERVICE_POLICY_JSON='{
  "clients": {
    "demo-vm-001": {
      "accounts": ["sender"],
      "sendRecipients": ["demo-recipient@example.invalid"],
      "historyRecipients": ["demo-recipient@example.invalid"],
      "createChatParticipants": ["demo-recipient@example.invalid"],
      "pairing": false,
      "manageAccounts": false
    },
    "operator": {
      "accounts": ["sender", "responder"],
      "recipients": ["*"],
      "pairing": true,
      "manageAccounts": true
    }
  }
}'
```

The policy fails closed when configured: unknown clients, disallowed accounts,
and disallowed recipients return `403` with a `wa_service_policy_denied` audit
event in the JSON response. Recipient checks apply to send, history/meta/recover,
and group creation participant routes. Pairing and account-management routes also
require the corresponding boolean flag for the client.

## Carry Existing Login

Do not copy WhatsApp session files into the public repo or print session paths in
logs. To carry an existing linked WhatsApp Web login, move ownership of the
existing account configuration to `orkestr-wa`:

1. Record the current private runtime values from the deployment environment:
   `ORKESTR_WHATSAPP_ACCOUNT_IDS`,
   `ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS`, and
   `ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS`.
2. Put those values in the private environment file used by the new
   `orkestr-wa.service`.
3. Stop the embedded bridge owner before starting `orkestr-wa.service`. Two
   Chrome clients must not use the same WhatsApp Web LocalAuth directory.
4. Start `orkestr-wa.service` and verify the carried accounts:

```bash
ORKESTR_WA_SERVICE_TOKEN=replace-with-local-secret \
node scripts/orkestr-wa-readiness.mjs \
  --bridge-url http://127.0.0.1:18914 \
  --account sender \
  --account responder
```

5. Reconfigure every Orkestr UI/API instance that should use the service:

```bash
WHATSAPP_BRIDGE_MODE=external
ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED=1
WHATSAPP_BRIDGE_URL=http://127.0.0.1:18914
WHATSAPP_BRIDGE_TOKEN=replace-with-local-secret
ORKESTR_WA_SERVICE_CLIENT_ID=demo-vm-001
ORKESTR_WHATSAPP_AUTOSTART=0
WHATSAPP_LOCAL_AUTOSTART=0
```

After that restart, `orkestr-ui.service`, OSS demo instances, and managed
instances should all see the same external account status without owning the
WhatsApp Chrome profile themselves.

When a client id is configured, Orkestr sends it to `orkestr-wa` as
`X-Orkestr-Instance-Id`. Supported identity sources, in priority order, are
`ORKESTR_WA_SERVICE_CLIENT_ID`, `ORKESTR_WHATSAPP_BRIDGE_CLIENT_ID`,
`WHATSAPP_BRIDGE_CLIENT_ID`, bridge instance id env vars, and the generic
Orkestr instance env vars. Use the same value as the corresponding
`ORKESTR_WA_SERVICE_POLICY_JSON.clients` key.

## Readiness Gate

Use the readiness checker before demo release, after host restarts, and during VM
isolation audits:

```bash
node scripts/orkestr-wa-readiness.mjs \
  --bridge-url "${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:18914}" \
  --require-routing-policy \
  --require-access-policy \
  --account sender \
  --account responder
```

The checker matches accounts by `accountId`, `id`, `label`, `runtimeAccountId`,
phone/contact id, and legacy role aliases. With `--require-routing-policy`, it
also verifies that the sender account queues inbound work and the responder
account is used for outbound/tool traffic only. With `--require-access-policy`,
it also verifies that `ORKESTR_WA_SERVICE_POLICY_JSON` is enforced; add
`--client-id <client-id>` when a specific Orkestr instance entry must exist. It
exits non-zero when the service is unreachable, an account is missing, a required
account is not ready, the routing policy does not match, or the access policy is
not enforced.
