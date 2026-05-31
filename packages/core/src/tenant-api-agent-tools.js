import fs from "node:fs/promises";
import path from "node:path";
import {
  connectorAuthStatus,
  disconnectConnectorAuth,
  startConnectorAuth as beginConnectorAuth,
} from "../../connectors/src/connector-auth.js";
import { listTimersForPrincipal } from "./timers.js";
import { whereAmI } from "./whereiam.js";
import {
  createUserSkillForPrincipal,
  deleteUserSkillForPrincipal,
  getUserSkillForPrincipal,
  listUserSkillsForPrincipal,
  searchUserSkillsForPrincipal,
  setUserSkillForPrincipal,
} from "./user-skills.js";
import { linkUserPrivateIdentity } from "./users.js";
import { fileBrowserRootsForPrincipal, listFilesForPrincipal } from "./workspace-files.js";

function clean(value) {
  return String(value || "").trim();
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function scopedFilePath(rawPath = "", principal = {}, env = process.env) {
  const roots = await fileBrowserRootsForPrincipal(principal, env);
  const requested = clean(rawPath);
  const resolved = path.resolve(requested || roots[0]?.path || "");
  if (!roots.some((root) => pathInside(root.path || root, resolved))) {
    const error = new Error("file_path_forbidden");
    error.statusCode = 403;
    throw error;
  }
  return resolved;
}

function safeText(value = "", max = 60_000) {
  return String(value || "").slice(0, max);
}

function principalUserId(principal = {}) {
  const userId = clean(principal?.userId);
  if (!userId) {
    const error = new Error("user_required");
    error.statusCode = 403;
    throw error;
  }
  return userId;
}

function skillPatchFromArgs(args = {}) {
  const patch = {};
  if (clean(args.name)) patch.name = clean(args.name);
  if (clean(args.description)) patch.description = clean(args.description);
  if (clean(args.instructions)) patch.instructions = clean(args.instructions);
  if (args.enabled !== undefined) patch.enabled = args.enabled === true || args.enabled === "true";
  return patch;
}

async function linkConnectorIdentity(provider = "", account = "", principal = {}, env = process.env, args = {}) {
  const userId = principalUserId(principal);
  const normalizedProvider = clean(provider).toLowerCase();
  const normalizedAccount = clean(account).toLowerCase();
  if (!normalizedAccount) return [];
  return linkUserPrivateIdentity(userId, {
    provider: normalizedProvider,
    accountId: normalizedAccount,
    externalId: normalizedAccount,
    displayName: clean(args.displayName || args.name || normalizedAccount),
    source: "chat",
  }, {
    env,
    actorUserId: userId,
    migrate: args.migrate === true,
  });
}

async function startConnectorAuth(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  const provider = clean(args.provider).toLowerCase();
  const account = clean(args.account).toLowerCase();
  const identities = await linkConnectorIdentity(provider, account, principal, env, args);
  const oauth = await beginConnectorAuth(args, principal, env, fetchImpl);
  return { ...oauth, identities };
}

export function tenantApiAgentToolDefinitions() {
  return [
    {
      type: "function",
      name: "orkestr_whereiam",
      description: "Return this tenant's scoped Orkestr runtime context, capabilities, thread, and workspace.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_skills",
      description: "List this user's Orkestr skills and their user-specific descriptions. Use this when the user asks what skills are available.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_get_skill",
      description: "View one of this user's Orkestr skills by id.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "The skill id to view." },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_search_skills",
      description: "Search this user's Orkestr skills by id, name, description, or instructions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_skill",
      description: "Create a user-specific skill record. Refuse instead of calling this for requests involving scams, credential theft, unauthorized account access, or abuse.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short user-facing skill name." },
          description: { type: "string", description: "What this skill lets the assistant help with for this user." },
          instructions: { type: "string", description: "User-specific operating instructions. Do not include secrets or passwords." },
          enabled: { type: "boolean", description: "Whether the skill should be enabled immediately." },
        },
        required: ["name", "description", "instructions", "enabled"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_update_skill",
      description: "Update a user-specific Orkestr skill or enable/disable an existing skill.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "The skill id to update." },
          name: { type: "string", description: "New skill name, or empty string to keep it unchanged." },
          description: { type: "string", description: "New description, or empty string to keep it unchanged." },
          instructions: { type: "string", description: "New instructions, or empty string to keep them unchanged." },
          enabled: { type: "boolean", description: "Whether the skill should be enabled." },
        },
        required: ["skillId", "name", "description", "instructions", "enabled"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_delete_skill",
      description: "Delete a user-created skill. For built-in skills this disables the skill instead of removing the built-in record.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "The skill id to delete or disable." },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_files",
      description: "List files and directories inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional absolute or scoped path to list." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_file",
      description: "Read a UTF-8 text file inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_write_file",
      description: "Write a UTF-8 text file inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          text: { type: "string", description: "UTF-8 text content to write." },
        },
        required: ["path", "text"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_timers",
      description: "List timers visible to this tenant.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_start_connector_auth",
      description: "Start user-owned, tenant-scoped Gmail, Outlook, Jira, or Shopify sign-in from this chat using the parent Orkestr connector app. Use this when the user asks to connect, sign in, log in, set up, or reconnect one of these connectors. Do not describe this as admin setup.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["gmail", "outlook", "jira", "shopify"], description: "Connector provider to sign in." },
          account: { type: "string", description: "Optional email/account hint, or empty string if the user did not provide one." },
          shop: { type: "string", description: "Shopify shop domain/name for Shopify sign-in, or empty string for other providers." },
        },
        required: ["provider", "account", "shop"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_connector_status",
      description: "Return safe connection and setup state for a tenant connector without reading connector data or exposing tokens. Use this when the user asks whether a connector is connected, available, enabled, configured, accessible, or usable.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["gmail", "outlook", "jira", "shopify", "whatsapp"], description: "Connector provider to inspect." },
        },
        required: ["provider"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_disconnect_connector",
      description: "Disconnect this user's scoped connector token or pending OAuth state. This does not alter parent app credentials.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["gmail", "outlook", "jira", "shopify"], description: "Connector provider to disconnect." },
          account: { type: "string", description: "Optional account hint for user-facing confirmation, or empty string." },
        },
        required: ["provider", "account"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

export async function runTenantApiAgentTool(name = "", args = {}, context = {}, env = process.env) {
  const principal = context.principal || null;
  const thread = context.thread || null;
  const tool = clean(name);
  if (tool === "orkestr_whereiam") {
    return whereAmI({ threadId: thread?.id || "", cwd: thread?.cwd || thread?.workspace || "", principal }, env);
  }
  if (tool === "orkestr_list_skills") {
    return listUserSkillsForPrincipal(principalUserId(principal), principal, env);
  }
  if (tool === "orkestr_get_skill") {
    return getUserSkillForPrincipal(principalUserId(principal), args.skillId, principal, env);
  }
  if (tool === "orkestr_search_skills") {
    return searchUserSkillsForPrincipal(principalUserId(principal), args.query, principal, env);
  }
  if (tool === "orkestr_create_skill") {
    return createUserSkillForPrincipal(principalUserId(principal), {
      ...skillPatchFromArgs(args),
      createdBy: "chat",
    }, principal, env);
  }
  if (tool === "orkestr_update_skill") {
    return setUserSkillForPrincipal(principalUserId(principal), args.skillId, skillPatchFromArgs(args), principal, env);
  }
  if (tool === "orkestr_delete_skill") {
    return deleteUserSkillForPrincipal(principalUserId(principal), args.skillId, principal, env);
  }
  if (tool === "orkestr_list_files") {
    return listFilesForPrincipal(clean(args.path), principal, env);
  }
  if (tool === "orkestr_read_file") {
    const filePath = await scopedFilePath(args.path, principal, env);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      const error = new Error("not_a_file");
      error.statusCode = 400;
      throw error;
    }
    if (stats.size > 256 * 1024) {
      const error = new Error("file_too_large");
      error.statusCode = 413;
      throw error;
    }
    return {
      path: filePath,
      text: await fs.readFile(filePath, "utf8"),
      size: stats.size,
    };
  }
  if (tool === "orkestr_write_file") {
    const filePath = await scopedFilePath(args.path, principal, env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, safeText(args.text), "utf8");
    const stats = await fs.stat(filePath).catch(() => null);
    return { ok: true, path: filePath, size: stats?.size ?? null };
  }
  if (tool === "orkestr_list_timers") {
    return { timers: await listTimersForPrincipal(principal, env) };
  }
  if (tool === "orkestr_start_connector_auth") {
    return startConnectorAuth(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_connector_status") {
    return connectorAuthStatus(args.provider, env, { principal });
  }
  if (tool === "orkestr_disconnect_connector") {
    return disconnectConnectorAuth(args, principal, env);
  }
  const error = new Error("api_agent_tool_not_allowed");
  error.statusCode = 403;
  throw error;
}
