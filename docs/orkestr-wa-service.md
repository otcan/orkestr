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
ORKESTR_WHATSAPP_AUTOSTART=0
WHATSAPP_LOCAL_AUTOSTART=0
```

After that restart, `orkestr-ui.service`, OSS demo instances, and managed
instances should all see the same external account status without owning the
WhatsApp Chrome profile themselves.

## Readiness Gate

Use the readiness checker before demo release, after host restarts, and during VM
isolation audits:

```bash
node scripts/orkestr-wa-readiness.mjs \
  --bridge-url "${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:18914}" \
  --account sender \
  --account responder
```

The checker matches accounts by `accountId`, `id`, `label`, `runtimeAccountId`,
phone/contact id, and legacy role aliases. It exits non-zero when the service is
unreachable, an account is missing, or a required account is not ready.
