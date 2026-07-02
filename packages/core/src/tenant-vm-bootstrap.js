import fs from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../../storage/src/store.js";
import { startCodexAppServerThread } from "./codex-app-server.js";
import { createThread, getThread, updateThread } from "./threads.js";

const defaultWorkspaceRoot = "/opt/orkestr/workspace";

function clean(value = "") {
  return String(value || "").trim();
}

function cleanObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function falsey(value = "") {
  return ["0", "false", "off", "no"].includes(clean(value).toLowerCase());
}

function safeId(value = "", fallback = "tenant-vm-chat") {
  const id = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return id || fallback;
}

function safeAbsolutePath(value = "", fallback = "") {
  const raw = clean(value || fallback);
  if (!raw || raw.includes("\0") || !raw.startsWith("/")) return fallback;
  const normalized = path.posix.normalize(raw);
  return normalized.startsWith("/") ? normalized : fallback;
}

function profilePath(env = process.env) {
  return clean(env.ORKESTR_TENANT_BOOTSTRAP_PROFILE || env.ORKESTR_TENANT_BOOTSTRAP_PROFILE_PATH) ||
    "/etc/orkestr/tenant-bootstrap-profile.json";
}

async function readProfile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function bootstrapShouldStartCodex(profile = {}, env = process.env) {
  if (falsey(env.ORKESTR_TENANT_BOOTSTRAP_START_CODEX)) return false;
  const firstChat = cleanObject(profile.firstChat);
  return firstChat.autoWake !== false;
}

function whatsappBootstrapBinding({ threadId = "", threadName = "", whatsapp = {} } = {}) {
  const chatId = clean(whatsapp.chatId);
  if (!chatId || whatsapp.enabled === false) return null;
  const accountId = clean(whatsapp.accountId);
  const bindingId = `thread:${threadId}:whatsapp`;
  return {
    id: bindingId,
    bindingId,
    connector: "whatsapp",
    chatId,
    displayName: clean(whatsapp.chatName || threadName || chatId),
    enabled: true,
    routeEligible: true,
    generated: true,
    tenantVmBootstrap: true,
    mirrorToWhatsApp: true,
    senderAccountId: accountId || null,
    inboundAccountId: accountId || null,
    receivingAccountId: accountId || null,
    responderAccountId: accountId || null,
    outboundAccountId: accountId || null,
    acl: {
      receive: { mode: "all-users" },
      read: { mode: "owner-only" },
      send: { mode: "owner-only" },
      manage: { mode: "owner-only" },
    },
    updatedAt: new Date().toISOString(),
  };
}

export function tenantVmBootstrapThreadInput(profileInput = {}, env = process.env) {
  const profile = cleanObject(profileInput);
  const firstChat = cleanObject(profile.firstChat);
  const workspace = cleanObject(profile.workspace);
  const codex = cleanObject(profile.codex);
  const connectors = cleanObject(profile.connectors);
  const whatsapp = cleanObject(connectors.whatsapp);
  const threadId = safeId(firstChat.id || profile.tenantVmId || firstChat.name || profile.displayName, "tenant-vm-chat");
  const threadName = clean(firstChat.name || firstChat.title || profile.displayName || threadId);
  const workspaceRoot = safeAbsolutePath(workspace.root, `${defaultWorkspaceRoot}/${threadId}`);
  const binding = whatsappBootstrapBinding({ threadId, threadName, whatsapp });
  return {
    id: threadId,
    ownerUserId: clean(profile.ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin"),
    name: threadName,
    title: clean(firstChat.title || threadName),
    bindingName: binding?.displayName || threadName,
    state: "sleeping",
    wakePolicy: "wake-on-message",
    cwd: workspaceRoot,
    workspace: workspaceRoot,
    runtimeKind: "codex-app-server",
    runtime: { runtimeKind: "codex-app-server" },
    executorId: "codex",
    executor: {
      id: "codex",
      type: "codex",
      transport: "app-server",
      metadata: {
        runtimeKind: "codex-app-server",
        transport: "app-server",
        tenantVmBootstrap: true,
      },
    },
    codexMode: clean(codex.mode || "code").toLowerCase() === "plan" ? "plan" : "code",
    codexModel: clean(codex.model),
    codexReasoningEffort: clean(codex.reasoningEffort),
    binding,
  };
}

function threadPatchFromBootstrapInput(input = {}, existing = null) {
  return {
    ownerUserId: input.ownerUserId,
    name: input.name,
    title: input.title,
    wakePolicy: input.wakePolicy,
    cwd: input.cwd,
    workspace: input.workspace,
    runtimeKind: input.runtimeKind,
    runtime: existing?.codexThreadId ? existing.runtime : input.runtime,
    executorId: input.executorId,
    executor: existing?.codexThreadId
      ? {
        ...(existing.executor || {}),
        id: "codex",
        type: "codex",
        transport: "app-server",
        metadata: {
          ...(existing.executor?.metadata || {}),
          runtimeKind: "codex-app-server",
          transport: "app-server",
          tenantVmBootstrap: true,
        },
      }
      : input.executor,
    binding: input.binding,
    bindingName: input.bindingName,
    codexMode: input.codexMode,
    codexModel: input.codexModel || null,
    codexReasoningEffort: input.codexReasoningEffort || null,
  };
}

function publicStartError(error) {
  return clean(error?.message || String(error || "")).slice(0, 240);
}

export async function bootstrapTenantVmFromProfile(profileInput = null, env = process.env, options = {}) {
  const filePath = profilePath(env);
  const profile = profileInput || await readProfile(filePath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!profile) return { ok: true, skipped: "tenant_bootstrap_profile_missing", profilePath: filePath };
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    const error = new Error("tenant_bootstrap_profile_invalid");
    error.statusCode = 400;
    throw error;
  }

  const input = tenantVmBootstrapThreadInput(profile, env);
  await fs.mkdir(input.cwd, { recursive: true }).catch(() => {});
  const existing = await getThread(input.id, env).catch(() => null);
  const created = !existing;
  let thread = await createThread(input, env);
  thread = await updateThread(thread.id, threadPatchFromBootstrapInput(input, existing || thread), env);
  await appendEvent({
    type: "tenant_vm_bootstrap_thread_ready",
    tenantVmId: clean(profile.tenantVmId),
    threadId: thread.id,
    ownerUserId: thread.ownerUserId || null,
    whatsappChatId: clean(input.binding?.chatId),
    created,
  }, env).catch(() => {});

  let codexStart = { attempted: false, skipped: "disabled" };
  if (bootstrapShouldStartCodex(profile, env)) {
    codexStart = { attempted: true, ok: false };
    try {
      const started = await (options.startCodexThread || startCodexAppServerThread)(thread, env);
      thread = started?.thread || await getThread(thread.id, env) || thread;
      codexStart = {
        attempted: true,
        ok: Boolean(started?.thread),
        codexThreadId: clean(thread.codexThreadId),
      };
    } catch (error) {
      codexStart = {
        attempted: true,
        ok: false,
        error: publicStartError(error),
      };
      await appendEvent({
        type: "tenant_vm_bootstrap_codex_start_failed",
        tenantVmId: clean(profile.tenantVmId),
        threadId: thread.id,
        error: codexStart.error,
      }, env).catch(() => {});
    }
  }

  return {
    ok: true,
    profilePath: filePath,
    tenantVmId: clean(profile.tenantVmId),
    thread,
    created,
    codexStart,
  };
}
