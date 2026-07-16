# Connector MCP Gateway

The connector MCP deployment separates connector routing and durability from
the Orkestr UI process. WhatsApp is the first transport implementation. Gmail,
Outlook, Jira, and Shopify authentication use the same generic auth tool.

## Process ownership

- `orkestr-connectors-mcp.service` listens on `127.0.0.1:18914/mcp`. It owns
  scoped authorization, routing, and durable inbox/outbox state. It does not
  import `whatsapp-web.js`.
- `orkestr-wa-worker@sender.service` is the only owner of the production
  WhatsApp browser. Its protocol is private at `/run/orkestr-wa/sender.sock`.
- `orkestr-ui.service` consumes MCP. UI deploys do not restart WhatsApp.
- Tenant VMs use `http://10.42.0.1:18913/mcp` with an instance, owner, account,
  and chat-scoped bearer token.
- The optional personal +49 deployment uses a separate gateway, worker,
  `ORKESTR_HOME`, socket, tokens, and policy. It is not a tenant router account.

## Contract

The server uses stateless Streamable HTTP, protocol `2025-11-25`, and the
official TypeScript SDK. The canonical tools are:

- `orkestr_auth`: `status`, `connect`, `reconnect`, `disconnect`, `logout`
- `orkestr_messaging`: idempotent `send_text`
- `orkestr_conversation`: `list`, `history`, `participants`, `recover`, `create`
- `orkestr_routing`: `status`, `bind`, `unbind`, `pause`, `resume`, `retry`

Every result includes `contract_version`, service/action/status,
`operation_ref`, effective scope, an optional challenge, and a structured
error. The bearer is authoritative; context arguments must match it.

Account changes, route changes, new chats, and first-time recipients return an
attended Orkestr challenge. Existing scoped chat sends do not. Unconfirmed
WhatsApp delivery is not automatically resent. MCP attachment inputs accept
only opaque Orkestr-staged `att_...` references, never paths or URLs.

## Configuration

```text
ORKESTR_CONNECTORS_MCP_URL=http://127.0.0.1:18914/mcp
ORKESTR_CONNECTORS_MCP_TOKEN=<operator-token>
ORKESTR_WA_WORKER_SOCKET=/run/orkestr-wa/sender.sock
ORKESTR_WA_WORKER_TOKEN=<private-worker-token>
ORKESTR_WA_WORKER_EVENT_SINK_URL=http://127.0.0.1:18914/internal/whatsapp/inbound
ORKESTR_WA_WORKER_EVENT_TOKEN=<private-event-token>
WHATSAPP_BRIDGE_MODE=external
WHATSAPP_BRIDGE_URL=http://127.0.0.1:18914
```

Tenant provisioning adds MCP read/send/manage scopes to the tenant route token
and configures:

```text
ORKESTR_CONNECTORS_MCP_URL=http://10.42.0.1:18913/mcp
ORKESTR_CONNECTORS_MCP_BEARER_TOKEN=<tenant-scoped-token>
```

Codex stores the environment variable name, not the token:

```bash
codex mcp add orkestr_connectors \
  --url http://127.0.0.1:18914/mcp \
  --bearer-token-env-var ORKESTR_CONNECTORS_MCP_TOKEN
```

## Operations

Set `ORKESTR_INSTALL_CONNECTORS_MCP=1` for `scripts/install.sh --systemd`.
This installs the gateway, worker template, and a one-minute doctor timer.
`ORKESTR_INSTALL_PERSONAL_CONNECTORS_MCP=1` installs the isolated personal
deployment on port `18749`.

Stage and activate connector releases independently of UI releases:

```bash
scripts/deploy-connectors-release.sh
scripts/deploy-connectors-release.sh --activate
```

Activation is attended. It stops only connector services, switches
`/opt/orkestr-connectors/current`, starts worker then gateway, checks health,
and retains at most three connector releases.

## Migration

1. Stage and test the connector release without activation.
2. Configure separate gateway, worker, event, and scoped bearer tokens.
3. Drain new inputs and let active turns finish.
4. Stop the embedded UI-owned WhatsApp runtime and verify there is one profile
   owner.
5. Start the worker with the supported existing account/session configuration.
6. Verify health, `tools/list`, account readiness, scoped history, and one
   idempotent send.
7. Set the UI to external bridge mode, resume input, and verify main and tenant
   inbound/reply round trips.
8. Keep REST compatibility loopback-only for one release, then set
   `ORKESTR_CONNECTORS_MCP_LEGACY_REST=0`.

The doctor watches gateway, worker, required accounts, queue, and dead letters.
Repairs are limited to three per hour and restart connector services only.
Alerts go to systemd journal and must not depend on WhatsApp.
