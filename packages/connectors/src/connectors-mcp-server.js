import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  connectorMcpCapabilities,
  connectorMcpToolResult,
  connectorsMcpInputSchemas,
  connectorsMcpToolDescriptors,
} from "./connectors-mcp-contract.js";
import { runConnectorMcpTool } from "./connectors-mcp-operations.js";
import { whatsappWorkerHealth } from "./whatsapp-worker-client.js";
import { listConnectorOutboxJobs } from "./connector-outbox.js";
import { listWhatsAppBindingStatuses } from "./whatsapp-account-bindings.js";

function jsonResource(uri, value) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
}

function scopedItems(items = [], auth = {}, fields = []) {
  if (auth.operator) return items;
  return items.filter((item) => fields.every(([authKey, itemKeys]) => {
    const expected = String(auth[authKey] || "").trim();
    if (!expected) return true;
    return itemKeys.some((key) => String(item?.[key] || "").trim() === expected);
  }));
}

export function createConnectorsMcpServer({ auth = {}, request = null, env = process.env } = {}) {
  const server = new McpServer({
    name: "orkestr-connectors",
    version: "1.0.0",
    websiteUrl: "https://orkestr.de",
  });

  for (const descriptor of connectorsMcpToolDescriptors) {
    server.registerTool(descriptor.name, {
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: connectorsMcpInputSchemas[descriptor.name].shape,
      annotations: {
        title: descriptor.title,
        readOnlyHint: descriptor.name === "orkestr_auth" ? false : descriptor.readOnlyHint,
        destructiveHint: descriptor.name === "orkestr_routing" || descriptor.name === "orkestr_auth",
        idempotentHint: descriptor.name === "orkestr_messaging",
        openWorldHint: true,
      },
    }, async (input) => connectorMcpToolResult(await runConnectorMcpTool(descriptor.name, input, { auth, request, env })));
  }

  server.registerResource("connector-capabilities", "orkestr://connectors/capabilities", { mimeType: "application/json" }, async () =>
    jsonResource("orkestr://connectors/capabilities", connectorMcpCapabilities())
  );
  server.registerResource("connector-accounts", "orkestr://connectors/accounts", { mimeType: "application/json" }, async () => {
    const health = await whatsappWorkerHealth(env);
    const accounts = scopedItems(health.accounts || [], auth, [["accountId", ["accountId", "id"]]]);
    return jsonResource("orkestr://connectors/accounts", { service: "whatsapp", accounts });
  });
  server.registerResource("connector-operations", "orkestr://connectors/operations", { mimeType: "application/json" }, async () => {
    const operations = await listConnectorOutboxJobs({
      ownerUserId: auth.operator ? "" : auth.ownerUserId,
      accountId: auth.accountId || "",
    }, env);
    return jsonResource("orkestr://connectors/operations", { operations });
  });
  server.registerResource("connector-routes", "orkestr://connectors/routes", { mimeType: "application/json" }, async () => {
    const status = await listWhatsAppBindingStatuses({ env });
    const routes = scopedItems(status.bindings || [], auth, [
      ["ownerUserId", ["ownerUserId", "userId"]],
      ["instanceId", ["instanceId"]],
      ["accountId", ["accountId", "responderAccountId", "outboundAccountId"]],
    ]);
    return jsonResource("orkestr://connectors/routes", { service: "whatsapp", routes });
  });
  server.registerResource("connector-health", "orkestr://connectors/health", { mimeType: "application/json" }, async () => {
    const worker = await whatsappWorkerHealth(env).catch((error) => ({ ok: false, error: error?.message || String(error) }));
    return jsonResource("orkestr://connectors/health", {
      ok: worker.ok !== false,
      gateway: { ok: true, browserFree: true },
      worker: { ok: worker.ok !== false, state: worker.state || "", error: worker.error || "" },
    });
  });

  return server;
}
