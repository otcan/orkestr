import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function clean(value = "") {
  return String(value || "").trim();
}

export function connectorsMcpClientConfig(env = process.env) {
  const bridgeUrl = clean(env.WHATSAPP_BRIDGE_URL || env.ORKESTR_WHATSAPP_BRIDGE_URL).replace(/\/+$/g, "");
  return {
    url: clean(env.ORKESTR_CONNECTORS_MCP_URL || (bridgeUrl ? `${bridgeUrl}/mcp` : "http://127.0.0.1:18914/mcp")),
    token: clean(
      env.ORKESTR_CONNECTORS_MCP_BEARER_TOKEN ||
      env.ORKESTR_CONNECTORS_MCP_TOKEN ||
      env.WHATSAPP_BRIDGE_TOKEN ||
      env.WA_HTTP_TOKEN,
    ),
  };
}

export async function withConnectorsMcpClient(callback, env = process.env, options = {}) {
  const config = connectorsMcpClientConfig(env);
  if (!config.token) throw Object.assign(new Error("connector_mcp_token_unconfigured"), { statusCode: 503 });
  const client = new Client({ name: options.clientName || "orkestr-runtime", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { authorization: `Bearer ${config.token}` } },
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export function listConnectorsMcpTools(env = process.env, options = {}) {
  return withConnectorsMcpClient((client) => client.listTools(), env, options);
}

export async function callConnectorsMcpTool(name = "", args = {}, env = process.env, options = {}) {
  const result = await withConnectorsMcpClient((client) => client.callTool({ name: clean(name), arguments: args }), env, options);
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: result?.isError !== true, content: result?.content || [] };
  }
}
