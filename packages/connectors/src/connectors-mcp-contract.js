import * as z from "zod/v4";

export const connectorsMcpContractVersion = "1.3";
export const connectorsMcpProtocolVersion = "2025-11-25";

const cleanString = z.string().trim();
const serviceSchema = z.enum(["whatsapp", "gmail", "outlook", "jira", "shopify", "webui", "codex", "runtime"]);
const contextShape = {
  service: serviceSchema.describe("Connector service to operate."),
  account_id: cleanString.nullish().describe("Stable account id for the selected connector service. Authority still comes from the MCP bearer token."),
  instance_id: cleanString.nullish().describe("Orkestr instance id for context. It must match the bearer scope."),
  user_id: cleanString.nullish().describe("Orkestr user id for context. It must match the bearer scope."),
  thread_id: cleanString.nullish().describe("Orkestr thread id for context. It must match the bearer scope when scoped."),
  approval: cleanString.nullish().describe("Approved Orkestr challenge id or approval code for an attended administrative write."),
};

export const connectorsMcpInputSchemas = {
  orkestr_auth: z.object({
    ...contextShape,
    action: z.enum(["status", "connect", "reconnect", "disconnect", "logout"]),
    account_hint: cleanString.nullish().describe("Optional account hint. Gmail and other chooser-based providers do not require one."),
    target: cleanString.nullish().describe("Optional provider target such as a Shopify shop domain."),
    alias: cleanString.nullish().describe("Optional stable display alias for a newly connected account."),
    use_mode: z.enum(["default", "available", "explicit_only"]).nullish().describe("Discovery policy for a Google Workspace connection."),
    oauth_app: cleanString.nullish().describe("Named Google OAuth app profile. Omit for the deployment default; use a non-default profile only when the user explicitly requests it."),
    set_as_main: z.boolean().nullish().describe("Make this Google Workspace connection the user's main account."),
    set_as_thread_default: z.boolean().nullish().describe("Make this Google Workspace connection the default for the scoped thread."),
  }).strict(),
  orkestr_messaging: z.object({
    ...contextShape,
    action: z.enum(["send_text", "set_typing"]),
    conversation_id: cleanString.min(1).describe("Existing connector conversation id."),
    text: z.string().max(100_000).nullish(),
    attachment_refs: z.array(cleanString.min(1)).max(20).nullish().describe("Opaque Orkestr-staged attachment references. Filesystem paths and URLs are rejected."),
    idempotency_key: cleanString.min(1).max(240).nullish().describe("Stable caller-generated key used to prevent duplicate sends."),
    typing_state: z.enum(["composing", "paused"]).nullish().describe("Transient typing state. It is never written to the message outbox."),
  }).strict(),
  orkestr_conversation: z.object({
    ...contextShape,
    action: z.enum(["list", "history", "participants", "recover", "create"]),
    conversation_id: cleanString.nullish(),
    name: cleanString.nullish(),
    participant_ids: z.array(cleanString.min(1)).max(100).nullish(),
    limit: z.number().int().min(1).max(200).nullish(),
    unread_only: z.boolean().nullish(),
    mark_seen: z.boolean().nullish(),
    event_ids: z.array(cleanString.min(1).max(240)).max(20).nullish().describe("Exact connector event ids to recover within the scoped conversation."),
  }).strict(),
  orkestr_routing: z.object({
    ...contextShape,
    action: z.enum(["status", "bind", "unbind", "pause", "resume", "retry"]),
    binding_id: cleanString.nullish(),
    conversation_id: cleanString.nullish(),
    target_thread_id: cleanString.nullish(),
    operation_ref: cleanString.nullish(),
  }).strict(),
  orkestr_runtime: z.object({
    ...contextShape,
    service: z.literal("runtime"),
    action: z.enum(["progress", "checkpoint", "blocked", "complete"]),
    execution_id: cleanString.min(1).max(240).describe("Stable id for the current logical execution."),
    runtime_generation: cleanString.max(240).nullish().describe("Current runtime generation id. Stale generations are rejected."),
    turn_id: cleanString.max(240).nullish(),
    evidence_type: z.enum(["model_output", "tool_started", "tool_completed", "mcp_progress", "child_heartbeat", "output_growth", "desktop_heartbeat", "approval_pending", "user_input_pending"]).nullish(),
    phase: cleanString.max(120).nullish(),
    summary: cleanString.max(2_000).nullish(),
    checkpoint_id: cleanString.max(240).nullish(),
    checkpoint_json: z.string().max(65_536).nullish().describe("JSON object containing bounded resumable state for checkpoint actions."),
    progress_current: z.number().finite().nullish(),
    progress_total: z.number().finite().positive().nullish(),
    completion_status: z.enum(["completed", "cancelled", "failed"]).nullish(),
  }).strict(),
};

export const connectorsMcpToolDescriptors = [
  {
    name: "orkestr_auth",
    title: "Connector authentication",
    description: "Inspect or change authentication for any Orkestr connector. Administrative changes return an attended Orkestr challenge before execution.",
    readOnlyHint: false,
  },
  {
    name: "orkestr_messaging",
    title: "Connector messaging",
    description: "Send through a connector using an existing scoped conversation and a required idempotency key.",
    readOnlyHint: false,
  },
  {
    name: "orkestr_conversation",
    title: "Connector conversations",
    description: "List, inspect, recover, or create connector conversations. Creation is an attended administrative write.",
    readOnlyHint: false,
  },
  {
    name: "orkestr_routing",
    title: "Connector routing",
    description: "Inspect and administer durable Orkestr connector bindings and queued operations.",
    readOnlyHint: false,
  },
  {
    name: "orkestr_runtime",
    title: "Runtime progress and checkpoints",
    description: "Record scoped execution progress, durable checkpoints, blocked state, or completion without imposing a wall-clock timeout.",
    readOnlyHint: false,
  },
];

function jsonSchema(schema) {
  const result = z.toJSONSchema(schema, { target: "draft-7" });
  delete result.$schema;
  return result;
}

function strictOpenAiSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const next = { ...schema };
  if (next.properties && typeof next.properties === "object") {
    next.properties = Object.fromEntries(Object.entries(next.properties).map(([key, value]) => [key, strictOpenAiSchema(value)]));
    next.required = Object.keys(next.properties);
    next.additionalProperties = false;
  }
  if (next.items) next.items = strictOpenAiSchema(next.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(next[key])) next[key] = next[key].map(strictOpenAiSchema);
  }
  return next;
}

export function connectorsMcpOpenAiToolDefinitions() {
  return connectorsMcpToolDescriptors.map((descriptor) => ({
    type: "function",
    name: descriptor.name,
    description: descriptor.description,
    parameters: strictOpenAiSchema(jsonSchema(connectorsMcpInputSchemas[descriptor.name])),
    strict: true,
  }));
}

export function connectorMcpStructuredResult({
  service = "",
  action = "",
  status = "ok",
  operationRef = "",
  accountId = "",
  conversationId = "",
  instanceId = "",
  userId = "",
  threadId = "",
  challenge = null,
  error = null,
  data = null,
} = {}) {
  return {
    contract_version: connectorsMcpContractVersion,
    service: String(service || ""),
    action: String(action || ""),
    status: String(status || "ok"),
    operation_ref: String(operationRef || ""),
    scope: {
      account_id: String(accountId || ""),
      conversation_id: String(conversationId || ""),
      instance_id: String(instanceId || ""),
      user_id: String(userId || ""),
      thread_id: String(threadId || ""),
    },
    challenge: challenge || null,
    error: error ? {
      code: String(error.code || error.message || error || "connector_error"),
      retryable: error.retryable === true,
      requires_user_action: error.requiresUserAction === true || error.requires_user_action === true,
    } : null,
    data: data ?? null,
  };
}

export function connectorMcpToolResult(structuredContent) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(structuredContent?.status === "error" ? { isError: true } : {}),
  };
}

export function connectorMcpCapabilities() {
  return {
    contract_version: connectorsMcpContractVersion,
    protocol_version: connectorsMcpProtocolVersion,
    services: {
      whatsapp: {
        status: "available",
        auth: ["status", "connect", "reconnect", "disconnect", "logout"],
        messaging: ["send_text", "set_typing"],
        conversation: ["list", "history", "participants", "recover", "create"],
        routing: ["status", "bind", "unbind", "pause", "resume", "retry"],
      },
      gmail: { status: "available", auth: ["status", "connect", "reconnect", "disconnect", "logout"] },
      outlook: { status: "available", auth: ["status", "connect", "reconnect", "disconnect", "logout"] },
      jira: { status: "available", auth: ["status", "connect", "reconnect", "disconnect", "logout"] },
      shopify: { status: "available", auth: ["status", "connect", "reconnect", "disconnect", "logout"] },
      webui: { status: "planned" },
      codex: { status: "planned" },
      runtime: { status: "available", actions: ["progress", "checkpoint", "blocked", "complete"] },
    },
  };
}
