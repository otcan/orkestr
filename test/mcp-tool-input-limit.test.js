import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnectorsMcpServer } from "../packages/connectors/src/connectors-mcp-server.js";
import { createThreadBridgeMcpServer } from "../packages/core/src/thread-bridge-mcp.js";
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from "../packages/shared/src/mcp-limits.js";

async function callWith(server, name, args) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "limit-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } catch (error) {
    return { thrown: String(error?.message || error) };
  } finally {
    await client.close();
  }
}

const oversized = Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, index) => `${index}@c.us`);
const rejected = (result) => JSON.stringify(result).includes(`maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`);

test("GHSA-46jr: connector MCP rejects tool input over the element cap before validation", async () => {
  const server = createConnectorsMcpServer({ auth: { scopes: [] }, env: {} });
  const result = await callWith(server, "orkestr_conversation", { service: "whatsapp", action: "add_participants", conversation_id: "1@g.us", participant_ids: oversized });
  assert.ok(rejected(result), JSON.stringify(result).slice(0, 300));
});

test("GHSA-46jr: thread bridge MCP rejects tool input over the element cap before validation", async () => {
  const server = createThreadBridgeMcpServer({ principal: { scopes: [] }, env: {} });
  const { tools } = await (async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "list", version: "0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    const listed = await client.listTools();
    await client.close();
    return listed;
  })();
  const server2 = createThreadBridgeMcpServer({ principal: { scopes: [] }, env: {} });
  const result = await callWith(server2, tools[0].name, { padding: oversized });
  assert.ok(rejected(result), JSON.stringify(result).slice(0, 300));
});
