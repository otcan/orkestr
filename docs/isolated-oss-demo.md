# Isolated OSS Demo Runbook

This runbook is for the private VM demo flow. The demo does not use
`app.orkestr.de` and does not send onboarding to a shared group chat.

## Roles

- Broker: public connect/auth entrypoint and instance registry.
- Parent ops Orkestr: operator control plane and WhatsApp relay owner.
- Isolated OSS VM: customer/demo runtime with its own `ORKESTR_HOME`, service,
  workspaces, browser profiles, connector config, threads, timers, and release
  updater.

## Required VM Environment

Set only the demo target number and broker/relay inputs needed for this VM:

```bash
ORKESTR_DEMO_MODE=1
ORKESTR_DEMO_WHATSAPP_NUMBER="+491700000000"
ORKESTR_DEMO_BROKER_BASE_URL="https://connect.orkestr.de"
ORKESTR_CONNECT_PUBLIC_BASE_URL="https://connect.orkestr.de"
ORKESTR_DEMO_WHATSAPP_RELAY_URL="https://connect.orkestr.de/api/connectors/whatsapp/bridge"
ORKESTR_DEMO_WHATSAPP_RELAY_ACCOUNT_ID="responder"
ORKESTR_INSTANCE_DESKTOPS_PROVISIONED=0
ORKESTR_BROKER_INSTANCE_STORE=sqlite
ORKESTR_UPDATE_REF=main
ORKESTR_DEPLOY_CHANNEL=oss-main
ORKESTR_DEPLOY_TAGS_ONLY=0
```

Secrets such as relay tokens and registration tokens must be supplied by the
operator secret channel, not committed into the repo or printed in logs.

## Startup Flow

1. The VM boots with a fresh `ORKESTR_HOME`.
2. `scripts/demo-vm-ready-notify.mjs` registers with the broker through
   `POST /api/broker/instances/register`.
3. The broker issues a UUID, channel id, broker public key, and encrypted
   welcome payload.
4. The VM stores its client registration under its local secret store.
5. The VM sends a direct WhatsApp onboarding message to
   `ORKESTR_DEMO_WHATSAPP_NUMBER`.
6. The message includes `https://connect.orkestr.de/i/<uuid>/setup`.
7. The broker verifies that `<uuid>` exists before redirecting to pairing.

## Verification

Run these on the VM:

```bash
curl -fsS http://127.0.0.1:${ORKESTR_PORT:-3000}/api/version
npm run audit:isolation
```

Expected audit properties:

- all runtime paths are inside this VM's `ORKESTR_HOME`
- broker registry is SQLite when `ORKESTR_ISOLATION_EXPECT_SQLITE_BROKER=1`
- unprovisioned desktops return `instance_desktops_not_provisioned`
- parent/private desktop names do not appear in runtime state
- `browserctl` must be VM-local, for example `/app/scripts/browserctl.mjs`;
  ambient parent-host backends such as `/usr/local/bin/browserctl` fail the
  isolation audit

Run this against the broker route:

```bash
curl -i "https://connect.orkestr.de/i/<uuid>/setup"
```

Expected result: `302` to `/setup/pairing?instanceId=<uuid>&return=%2Fsetup`.
Unknown UUIDs must return `404`; disabled or expired instances must not route.

## Real WhatsApp E2E

Before a demo release, run:

```bash
ORKESTR_CONNECT_PUBLIC_BASE_URL=https://connect.orkestr.de \
ORKESTR_REAL_WA_DEMO_CHAT_ID='<direct-user-chat-id>' \
ORKESTR_REAL_WA_DEMO_RESPONDER_ACCOUNT=responder \
npm run e2e:whatsapp-demo-onboarding -- --execute
```

The artifact must show:

- a fresh UUID `instanceId`
- a setup URL under `/i/<uuid>/setup`
- no stale/static instance id in the setup URL
- successful setup URL reachability
- direct outbound WhatsApp prompt from the serving account

## Troubleshooting

- `broker_instance_not_found`: the VM did not register with the broker, or the
  link points to the wrong broker.
- `setup_url_must_not_be_local`: the onboarding URL would expose localhost;
  set `ORKESTR_CONNECT_PUBLIC_BASE_URL`.
- `relay_bridge_url_missing`: the VM has no relay URL; configure the relay or
  switch to a self-managed WhatsApp bridge in setup.
- `instance_desktops_not_provisioned`: expected for an idle/fresh VM until a
  desktop stack is provisioned locally inside that VM.
- Old release reappears after deploy: check the VM update timer and ensure
  `ORKESTR_UPDATE_REF`, `ORKESTR_DEPLOY_CHANNEL`, and tag-only settings match
  the intended demo track.
