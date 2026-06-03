import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { codexCommand, defaultCodexHome } from "../../connectors/src/codex.js";
import { codexAppServerSocket, codexAppServerTransport } from "../../connectors/src/codex-app-server-transport.js";
import { userDataPaths } from "../../storage/src/paths.js";
import {
  containedUserCodexModel,
  containedUserCodexReasoningEffort,
  containedUserDeveloperInstructions,
  threadRequiresTenantIsolation,
} from "./tenant-policy.js";
import {
  appendThreadMessage,
  listThreadMessages,
  listThreads,
  updateThread,
  updateThreadMessage,
} from "./threads.js";

export const appServerTransports = new Set(["app-server", "codex-app-server"]);
export const tmuxTransports = new Set(["tmux", "legacy", "codex-tmux"]);

export function nowIso() {
  return new Date().toISOString();
}

export function clean(value) {
  return String(value || "").trim();
}

export function runtimeHome(env = process.env, home = os.homedir()) {
  return clean(env.HOME || process.env.HOME || home || os.homedir());
}

function falsey(value) {
  return ["0", "false", "off", "no"].includes(clean(value).toLowerCase());
}

function safeOwnerUserId(thread = {}, env = process.env) {
  return clean(thread.ownerUserId || thread.userId || env.ORKESTR_ADMIN_USER_ID || "admin").replace(/[^a-zA-Z0-9_.-]/g, "_") || "admin";
}

export function containedCodexRuntimePaths(thread = {}, env = process.env) {
  const root = userDataPaths(safeOwnerUserId(thread, env), env).root;
  return {
    home: path.join(root, "runtime-home"),
    codexHome: path.join(root, "codex"),
  };
}

export function containedCodexRuntimeEnabled(thread = {}, env = process.env) {
  if (!threadUsesRestrictedCodexPolicy(thread, env)) return false;
  return !falsey(env.ORKESTR_CONTAINED_CODEX_ISOLATED_HOME);
}

export function codexRuntimeEnvForThread(thread = {}, env = process.env) {
  if (!containedCodexRuntimeEnabled(thread, env)) return { ...env };
  const paths = containedCodexRuntimePaths(thread, env);
  return {
    ...env,
    HOME: paths.home,
    CODEX_HOME: paths.codexHome,
    ORKESTR_CODEX_APP_SERVER_MODE: clean(env.ORKESTR_CONTAINED_CODEX_APP_SERVER_MODE || "stdio") || "stdio",
    ORKESTR_CODEX_APP_SERVER_SOCKET: "",
    ORKESTR_CODEX_SANDBOX: "workspace-write",
    ORKESTR_CODEX_APPROVAL_POLICY: "never",
    XDG_CONFIG_HOME: path.join(paths.home, ".config"),
    XDG_CACHE_HOME: path.join(paths.home, ".cache"),
    XDG_DATA_HOME: path.join(paths.home, ".local", "share"),
  };
}

export function containedCodexRuntimeMetadata(thread = {}, env = process.env) {
  if (!containedCodexRuntimeEnabled(thread, env)) return null;
  const paths = containedCodexRuntimePaths(thread, env);
  return {
    containedCodexIsolated: true,
    codexRuntimeHome: paths.home,
    codexHome: paths.codexHome,
  };
}

async function copyFileIfExists(source, target, mode = 0o600) {
  if (!source || !target || path.resolve(source) === path.resolve(target)) return false;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, target);
    await fs.chmod(target, mode).catch(() => {});
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureContainedCodexRuntimeHome(thread = {}, env = process.env) {
  if (!containedCodexRuntimeEnabled(thread, env)) return { isolated: false };
  const paths = containedCodexRuntimePaths(thread, env);
  await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  if (!falsey(env.ORKESTR_CONTAINED_CODEX_COPY_AUTH)) {
    const sourceCodexHome = defaultCodexHome(env, runtimeHome(env));
    await copyFileIfExists(path.join(sourceCodexHome, "auth.json"), path.join(paths.codexHome, "auth.json"), 0o600);
  }
  return { isolated: true, ...paths };
}

export function containedCodexRuntimeIsCurrent(thread = {}, env = process.env) {
  if (!containedCodexRuntimeEnabled(thread, env)) return true;
  const metadata = thread.executor?.metadata || {};
  const paths = containedCodexRuntimePaths(thread, env);
  return metadata.containedCodexIsolated === true &&
    clean(metadata.codexRuntimeHome) === paths.home &&
    clean(metadata.codexHome) === paths.codexHome;
}

export function clientKey(env = process.env, home = os.homedir()) {
  return JSON.stringify({
    command: codexCommand(env),
    home: runtimeHome(env, home),
    codexHome: defaultCodexHome(env, home),
    appServerTransport: codexAppServerTransport(env),
    appServerSocket: codexAppServerSocket(env),
    path: env.PATH || process.env.PATH || "",
    orkestrHome: env.ORKESTR_HOME || process.env.ORKESTR_HOME || "",
  });
}

export function commandEnv(env = process.env, home = os.homedir()) {
  return {
    ...process.env,
    ...env,
    HOME: runtimeHome(env, home),
    CODEX_HOME: defaultCodexHome(env, home),
  };
}

export function timeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_APP_SERVER_TIMEOUT_MS || 20_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 20_000;
}

export function threadEventId({ codexThreadId, turnId = "", itemId = "", type = "", role = "", text = "" }) {
  return [
    "codex-app-server",
    clean(codexThreadId),
    clean(turnId),
    clean(itemId),
    clean(type),
    clean(role),
    clean(text).slice(0, 256),
  ].join(":");
}

export function codexThreadId(thread) {
  return clean(thread?.executor?.codexThreadId || thread?.codexThreadId);
}

export function codexSessionId(thread) {
  return clean(thread?.executor?.codexSessionId || thread?.codexSessionId || thread?.executor?.metadata?.codexSessionId);
}

export function messageTextFromContent(content = []) {
  return (Array.isArray(content) ? content : [])
    .map((item) => clean(item?.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function userInputText(input = []) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item?.type === "text")
    .map((item) => clean(item.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function itemText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return clean(item.text);
  if (typeof item.review === "string") return clean(item.review);
  if (Array.isArray(item.content)) return messageTextFromContent(item.content);
  if (typeof item.aggregatedOutput === "string") return clean(item.aggregatedOutput);
  return "";
}

export function itemPhase(item) {
  if (item?.type === "plan") return "plan";
  if (item?.type === "agentMessage") return clean(item.phase || "final_answer") || "final_answer";
  if (item?.type === "exitedReviewMode") return "review";
  if (item?.type === "contextCompaction") return "context_compaction";
  return clean(item?.phase || "");
}

export function publicError(error) {
  if (!error) return "";
  return clean(error.message || error.stderr || error.stdout || String(error));
}

export function threadUsesRestrictedCodexPolicy(thread = {}, env = process.env) {
  return threadRequiresTenantIsolation(thread, env);
}

export function codexSandboxForThread(thread = {}, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) return "workspace-write";
  const requested = clean(thread.codexSandbox || thread.executor?.metadata?.codexSandbox || env.ORKESTR_CODEX_SANDBOX || "workspace-write") || "workspace-write";
  return requested;
}

export function appServerStateFromStatus(status) {
  const type = clean(status?.type).toLowerCase();
  if (type === "active") {
    const flags = Array.isArray(status?.activeFlags) ? status.activeFlags.map((flag) => clean(flag).toLowerCase()) : [];
    if (flags.some((flag) => ["waitingonapproval", "waiting_on_approval", "awaiting_approval"].includes(flag))) return "awaiting_approval";
    if (flags.length) return "working";
    return "ready";
  }
  if (type === "idle") return "ready";
  if (type === "systemError") return "failed";
  if (type === "notLoaded") return "unloaded";
  return "";
}

export function sandboxPolicyForTurn(thread, env = process.env) {
  const workspace = clean(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath);
  const sandbox = codexSandboxForThread(thread, env);
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only" || sandbox === "readOnly") return { type: "readOnly", networkAccess: false };
  const restricted = threadUsesRestrictedCodexPolicy(thread, env);
  return {
    type: "workspaceWrite",
    writableRoots: workspace ? [workspace] : [],
    networkAccess: !restricted,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function approvalPolicyForThread(thread, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) return "never";
  const requested = clean(thread.codexApprovalPolicy || thread.executor?.metadata?.codexApprovalPolicy || env.ORKESTR_CODEX_APPROVAL_POLICY || "on-request") || "on-request";
  return requested;
}

export function threadAutoAcceptsCodexApprovals(thread = {}, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) return false;
  return codexSandboxForThread(thread, env) === "danger-full-access" && approvalPolicyForThread(thread, env) === "never";
}

export function isCodexApprovalRequestMethod(method = "") {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(clean(method));
}

const codexReasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function normalizeCodexModel(value) {
  const model = clean(value);
  if (!model) return "";
  const lower = model.toLowerCase();
  if (/^\d+$/.test(lower)) return "";
  if (lower === "openai" || lower === "azure" || lower === "openrouter") return "";
  if (model.startsWith("/") || lower.endsWith(".jsonl")) return "";
  return model;
}

export function normalizeReasoningEffort(value) {
  const effort = clean(value).toLowerCase().replace(/[\s_-]+/g, "");
  if (!effort) return "";
  if (effort === "xhigh" || effort === "extrahigh") return "xhigh";
  return codexReasoningEfforts.has(effort) ? effort : "";
}

export function modelForThread(thread, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) return containedUserCodexModel();
  return [
    thread.codexModel,
    thread.executor?.metadata?.codexModel,
    process.env.ORKESTR_DEFAULT_CODEX_MODEL,
    process.env.OPENAI_MODEL,
  ].map(normalizeCodexModel).find(Boolean) || "";
}

export function effortForThread(thread, env = process.env) {
  if (threadUsesRestrictedCodexPolicy(thread, env)) return containedUserCodexReasoningEffort();
  return [
    thread.codexReasoningEffort,
    thread.executor?.metadata?.codexReasoningEffort,
    process.env.ORKESTR_DEFAULT_CODEX_REASONING,
  ].map(normalizeReasoningEffort).find(Boolean) || "";
}

export function codexInputText(message) {
  const text = clean(message?.text);
  const promptFile = clean(message?.promptFile);
  const body = promptFile
    ? text
      ? `${text}\n\nPrompt file: ${promptFile}`
      : `Run the prompt file: ${promptFile}`
    : text;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentLines = attachments
    .map((attachment, index) => {
      const filePath = clean(attachment?.path || attachment?.savedPath || attachment?.saved_path);
      if (!filePath) return "";
      return [
        `Attachment ${index + 1}: ${filePath}`,
        clean(attachment?.filename) ? `filename: ${clean(attachment.filename)}` : "",
        clean(attachment?.mimetype) ? `mimetype: ${clean(attachment.mimetype)}` : "",
        clean(attachment?.kind) ? `kind: ${clean(attachment.kind)}` : "",
      ].filter(Boolean).join("\n");
    })
    .filter(Boolean);
  if (!attachmentLines.length) return body;
  return [
    body || "WhatsApp attachment received.",
    "Attached local file path(s):",
    ...attachmentLines,
    "Use the file path(s) above as the source of truth for any attachment content.",
  ].filter(Boolean).join("\n\n");
}

export function threadStartParams(thread, env = process.env) {
  const params = {
    cwd: clean(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath) || null,
    approvalPolicy: approvalPolicyForThread(thread, env) || "on-request",
    sandbox: codexSandboxForThread(thread, env),
    serviceName: "orkestr_oss",
  };
  const developerInstructions = containedUserDeveloperInstructions(thread, env);
  if (developerInstructions) params.developerInstructions = developerInstructions;
  const model = modelForThread(thread, env);
  if (model) params.model = model;
  return params;
}

export function turnStartParams(thread, message, env = process.env) {
  const params = {
    threadId: codexThreadId(thread),
    input: [{ type: "text", text: codexInputText(message), text_elements: [] }],
    cwd: clean(thread.cwd || thread.workspace || thread.repoPath || thread.worktreePath) || null,
    approvalPolicy: approvalPolicyForThread(thread, env) || "on-request",
    sandboxPolicy: sandboxPolicyForTurn(thread, env),
  };
  const model = modelForThread(thread, env);
  const effort = effortForThread(thread, env);
  if (model) params.model = model;
  if (effort) params.effort = effort;
  return params;
}

export async function threadForCodexThreadId(codexId, env = process.env) {
  const id = clean(codexId);
  if (!id) return null;
  const threads = await listThreads(env).catch(() => []);
  return threads.find((thread) =>
    clean(thread?.executor?.codexThreadId || thread?.codexThreadId) === id ||
    clean(thread?.threadId) === id,
  ) || null;
}

export async function appendOrUpdateEventMessage(thread, input, env = process.env) {
  const eventId = clean(input.eventId);
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const existing = eventId ? messages.find((message) => message.eventId === eventId) : null;
  if (existing) {
    return updateThreadMessage(thread.id, existing.id, {
      ...input,
      state: input.state || existing.state || "completed",
    }, env).catch(() => existing);
  }
  return appendThreadMessage(thread.id, input, env);
}

export async function markThreadFromCodexStatus(thread, status, env = process.env) {
  const state = appServerStateFromStatus(status);
  if (!state) return;
  const activeTurnId = state === "working" ? thread.runtime?.activeTurnId || null : null;
  await updateThread(thread.id, {
    state,
    runtime: {
      ...(thread.runtime || {}),
      state,
      runtimeKind: "codex-app-server",
      codexStatus: status || null,
      activeTurnId,
      pendingRequest: state === "awaiting_approval" ? thread.runtime?.pendingRequest || null : null,
      updatedAt: nowIso(),
    },
  }, env).catch(() => {});
}

export function approvalPromptText(method, params = {}) {
  if (method === "item/commandExecution/requestApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : clean(params.command);
    const cwd = clean(params.cwd);
    const reason = clean(params.reason);
    return [
      "Codex is requesting command approval.",
      command ? `Command: ${command}` : "",
      cwd ? `Directory: ${cwd}` : "",
      reason ? `Reason: ${reason}` : "",
      "Approve or deny in Orkestr.",
    ].filter(Boolean).join("\n");
  }
  if (method === "item/fileChange/requestApproval") {
    return [
      "Codex is requesting file-change approval.",
      clean(params.reason) ? `Reason: ${clean(params.reason)}` : "",
      clean(params.grantRoot) ? `Path: ${clean(params.grantRoot)}` : "",
      "Approve or deny in Orkestr.",
    ].filter(Boolean).join("\n");
  }
  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    return [
      "Codex needs input.",
      ...questions.map((question, index) => {
        const options = Array.isArray(question.options)
          ? question.options.map((option, optionIndex) => `   ${optionIndex + 1}. ${clean(option.label)}${clean(option.description) ? `: ${clean(option.description)}` : ""}`).join("\n")
          : "";
        return `${index + 1}. ${clean(question.header || question.id || "Question")}: ${clean(question.question)}${options ? `\n${options}` : ""}`;
      }),
    ].filter(Boolean).join("\n");
  }
  return "";
}

export function codexRuntimeKind(env = process.env) {
  return "app-server";
}

export function codexAppServerEnabled(env = process.env) {
  return true;
}

export function isCodexRuntimeThread(thread) {
  const executorId = clean(thread?.executorId || thread?.executor?.id).toLowerCase();
  const executorType = clean(thread?.executor?.type).toLowerCase();
  const runtimeKind = clean(thread?.runtimeKind || thread?.runtime?.runtimeKind).toLowerCase();
  return executorId === "codex" ||
    executorType === "codex" ||
    Boolean(codexThreadId(thread)) ||
    runtimeKind === "codex-app-server" ||
    runtimeKind === "codex-tmux";
}

export function threadUsesCodexAppServer(thread, env = process.env) {
  const transport = clean(thread?.executor?.transport || thread?.runtimeKind || thread?.executor?.metadata?.transport).toLowerCase();
  if (appServerTransports.has(transport)) return true;
  if (tmuxTransports.has(transport)) return false;
  return clean(thread?.runtime?.runtimeKind || thread?.executor?.metadata?.runtimeKind).toLowerCase() === "codex-app-server";
}

export function threadNeedsCodexAppServerMigration(thread) {
  return isCodexRuntimeThread(thread) && !threadUsesCodexAppServer(thread);
}
