import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConnectorsMcpServer } from "../packages/connectors/src/connectors-mcp-server.js";
import { createThreadBridgeMcpServer } from "../packages/core/src/thread-bridge-mcp.js";

for (const [name, factory] of [
  ["connectors", () => createConnectorsMcpServer({ auth: {} })],
  ["threads", () => createThreadBridgeMcpServer({ principal: { scopes: [] } })],
]) {
  test(`${name} MCP bounds tool input before schema validation or tool execution`, async (t) => {
    const server = factory();
    const client = new Client({ name: "synthetic-input-bound", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length > 0, "ordinary protocol discovery remains available");
    const result = await client.callTool({ name: tools[0].name, arguments: { padding: Array(10_001).fill(null) } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /maximum of 10000 elements/);
  });
}
