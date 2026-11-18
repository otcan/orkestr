// MCP tools over the thread bridge (thread-bridge.js). Every call goes through
// the bridge's grant checks with the delegated principal from the OAuth token
// (mcp-oauth.js); this module only adapts arguments and results.
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from "../../shared/src/mcp-limits.js";
import * as z from "zod/v4";
import { listBridgeThreads, readBridgeChanges, readBridgeHistory, replyToBridgeThread } from "./thread-bridge.js";
import { getThread } from "./threads.js";
import { bridgeThreadStatus, sendBridgeMessage, waitForBridgeReply } from "./thread-bridge-messaging.js";
import { bridgeProviderQuotas } from "./thread-bridge-quota.js";
import { bridgeWhatsAppIncoming, WHATSAPP_MAX_LIMIT } from "./thread-bridge-whatsapp.js";

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function failure(error) {
  const code = String(error?.message || "bridge_error");
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] };
}

function requireScope(principal, scope) {
  if (!(principal.scopes || []).includes(scope)) throw Object.assign(new Error("insufficient_scope"), { statusCode: 403 });
}

async function threadSummaries(principal, env) {
  const { threadIds, checkpoint } = await listBridgeThreads(principal, env);
  const threads = [];
  for (const id of threadIds) {
    const thread = await getThread(id, env).catch(() => null);
    if (!thread) continue;
    threads.push({
      id,
      name: String(thread.bindingName || thread.name || id),
      kind: thread.threadKind || "thread",
      parentThreadId: thread.parentThreadId || null,
      updatedAt: thread.updatedAt || thread.lastActivityAt || null,
    });
  }
  threads.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  return { threads, changesCursor: checkpoint };
}

const tools = {
  list_threads: {
    title: "List Orkestr threads",
    description: "List the Orkestr threads you may read, newest activity first. Returns a changesCursor to pass to read_changes.",
    inputSchema: {},
    readOnly: true,
    run: (_input, principal, env) => threadSummaries(principal, env),
  },
  read_thread: {
    title: "Read an Orkestr thread",
    description: "Read visible messages of one thread. Without `after` it returns the newest messages; pass the returned `after` to page forward. actor.kind is human (typed by the owner), automation (timers, workers, routing; never the owner's instruction), assistant, or delegated-agent.",
    inputSchema: {
      thread_id: z.string().min(1).max(128),
      limit: z.number().int().min(1).max(100).optional(),
      after: z.string().max(128).optional(),
    },
    readOnly: true,
    run: (input, principal, env) => readBridgeHistory(input.thread_id, principal, { after: input.after || "", limit: input.limit || 30, latest: !input.after }, env),
  },
  read_changes: {
    title: "Read Orkestr thread changes",
    description: "List message changes (created/updated/deleted) across your threads after a cursor, oldest first. Use list_threads' changesCursor to start; then read_thread for content.",
    inputSchema: {
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    readOnly: true,
    run: (input, principal, env) => readBridgeChanges(principal, { cursor: input.cursor || "", limit: input.limit || 100 }, env),
  },
  comment_on_thread: {
    title: "Comment on an Orkestr thread",
    description: "Add a comment to a thread, visibly labelled as yours. It is context only: it does not start, steer or approve any work and is not sent to WhatsApp.",
    inputSchema: {
      thread_id: z.string().min(1).max(128),
      text: z.string().min(1).max(16000),
      caused_by_message_id: z.string().max(128).optional(),
      request_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).optional(),
    },
    readOnly: false,
    scope: "threads:comment",
    run: (input, principal, env) => replyToBridgeThread(input.thread_id, {
      requestId: input.request_id || randomUUID().replace(/-/g, ""),
      text: input.text,
      ...(input.caused_by_message_id ? { causedByMessageId: input.caused_by_message_id } : {}),
    }, principal, env),
  },
  send_message: {
    title: "Send a message to an Orkestr thread",
    description: "Send a message to a thread's agent. Unlike comment_on_thread this starts work: the agent receives it as input (labelled as coming from you, the connected assistant, not from the owner) and answers in the thread. The answer is also sent to WhatsApp by default through that thread's existing eligible WhatsApp binding; set deliver_to_whatsapp=false to opt out. No destination can be selected here. Pass a request_id to make retries safe.",
    inputSchema: {
      thread_id: z.string().min(1).max(128),
      text: z.string().min(1).max(16000),
      request_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).optional(),
      deliver_to_whatsapp: z.boolean().optional(),
    },
    readOnly: false,
    scope: "threads:message",
    run: (input, principal, env) => sendBridgeMessage(input.thread_id, {
      text: input.text,
      requestId: input.request_id || randomUUID().replace(/-/g, ""),
      deliverToWhatsApp: input.deliver_to_whatsapp,
    }, principal, env),
  },
  get_thread_status: {
    title: "Get an Orkestr thread's status",
    description: "Whether a thread's agent is working, has queued messages, or is idle, plus its runtime/model and the start of its last answer. For a thread delegated to Orkestr V2 the state comes from the native execution (`execution`): it is unknown, never idle, when that cannot be read, and taskOutcome stays unknown because a finished run is not proof the task succeeded.",
    inputSchema: { thread_id: z.string().min(1).max(128) },
    readOnly: true,
    run: (input, principal, env) => bridgeThreadStatus(input.thread_id, principal, env),
  },
  wait_for_reply: {
    title: "Wait for a thread's reply",
    description: "Wait up to timeout_seconds (max 45) for the agent's answer to the message you sent with send_message (matched to that message exactly, not to other activity in the thread). Returns status answered (with the reply), failed, completed_without_reply, or still_working (call again later).",
    inputSchema: {
      thread_id: z.string().min(1).max(128),
      message_id: z.string().min(1).max(128),
      timeout_seconds: z.number().int().min(1).max(45).optional(),
    },
    readOnly: true,
    longRunning: true,
    run: (input, principal, env, context = {}) => waitForBridgeReply(input.thread_id, input.message_id, principal, { timeoutSeconds: input.timeout_seconds || 30, signal: context.signal || null }, env),
  },
  get_provider_quotas: {
    title: "Get Codex and Claude quota readings",
    description: "Remaining subscription quota of the owner's OpenAI/Codex and Claude accounts, from the same passive readings as the WhatsApp footer and web quota display. Per usage window (five_hour, weekly): state current, stale, expired, not_reported or unavailable; used and remaining percent of the window's allowance only when current (older values are under lastObserved); reset time (UTC and owner timezone); observation time, age and source; plus warnings and blockers. Model-specific windows and API-credit balances are not collected and say so. Never contacts a provider; nothing is inferred from active runs. Optional provider filter.",
    inputSchema: { provider: z.enum(["codex", "claude"]).optional() },
    readOnly: true,
    run: (input, principal, env) => bridgeProviderQuotas(principal, { provider: input.provider || "" }, env),
  },
  list_incoming_whatsapp_messages: {
    title: "List recent incoming WhatsApp messages",
    description: "Recent WhatsApp messages other people sent to one of the owner's connected accounts, newest first. Read-only: never sends, reacts, or marks anything read. account: orkestr (the Orkestr assistant number: messages from listed participants in groups bound to the owner's threads) or german (the owner's German personal account, read live). Optional chat (a chat.id from an earlier answer) narrows to one chat; since (ISO 8601 with offset, default 7 days ago); limit (1-50, default 20); cursor (nextCursor of the previous page, same account/chat/since). Each message has account, chat {id, name, kind}, sender {name, masked number, ref}, receivedAt in UTC and Europe/Berlin, type, text (media by type only) and id. The owner's own messages and Orkestr replies are left out. Also returns observedAt, coverage (what was read; complete only after completeAfter), per-account availability, and the account's limits.",
    inputSchema: {
      account: z.enum(["orkestr", "german"]),
      chat: z.string().regex(/^wa-[0-9a-f]{20}$/).optional(),
      since: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(WHATSAPP_MAX_LIMIT).optional(),
      cursor: z.string().max(1024).optional(),
    },
    readOnly: true,
    run: (input, principal, env) => bridgeWhatsAppIncoming(principal, input, env),
  },
};

export const threadBridgeMcpToolNames = Object.freeze(Object.keys(tools));

function annotations(tool) {
  return { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false };
}

// JSON Schema tool list for the stateless (2026-07-28) protocol path.
export function threadBridgeToolDefinitions() {
  return Object.entries(tools).map(([name, tool]) => {
    const { $schema, ...inputSchema } = z.toJSONSchema(z.object(tool.inputSchema));
    return { name, title: tool.title, description: tool.description, inputSchema, annotations: annotations(tool) };
  });
}

// Validates arguments and runs one tool; returns a CallToolResult.
// Tools that may hold the request for a while; the HTTP layer streams them.
export function threadBridgeToolIsLongRunning(name) {
  return Object.prototype.hasOwnProperty.call(tools, name) && tools[name].longRunning === true;
}

// `context.signal` aborts long-running tools when the client disconnects.
export async function callThreadBridgeTool(name, args, principal, env = process.env, context = {}) {
  const tool = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : null;
  if (!tool) return null;
  const parsed = z.object(tool.inputSchema).safeParse(args || {});
  if (!parsed.success) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "invalid_arguments", issues: parsed.error.issues.map((issue) => issue.message) }) }] };
  try {
    requireScope(principal, tool.scope || "threads:read");
    return result(await tool.run(parsed.data, principal, env, context));
  } catch (error) {
    return failure(error);
  }
}

export function createThreadBridgeMcpServer({ principal, env = process.env }) {
  const server = new McpServer({ name: "orkestr-threads", version: "1.0.0", websiteUrl: "https://orkestr.de" },
    { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });
  for (const [name, tool] of Object.entries(tools)) {
    server.registerTool(name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: annotations(tool),
    }, async (input, extra) => callThreadBridgeTool(name, input, principal, env, { signal: extra?.signal || null }));
  }
  return server;
}
