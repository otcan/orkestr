import fs from "node:fs/promises";
import path from "node:path";
import {
  connectorAuthStatus,
  disconnectConnectorAuth,
  startConnectorAuth as beginConnectorAuth,
} from "../../connectors/src/connector-auth.js";
import {
  listBrowserSessions,
  openUrlInVirtualBrowser,
  openVirtualBrowser,
  prepareVirtualBrowser,
  restartVirtualBrowser,
  stopVirtualBrowser,
} from "../../browsers/src/browsers.js";
import { getGmailMessage, listGmailMessages } from "../../connectors/src/gmail.js";
import { runTenantApiAgentProfileTool, tenantApiAgentProfileToolDefinitions } from "./tenant-api-agent-profile-tools.js";
import { runTenantApiAgentTimerTool, tenantApiAgentTimerToolDefinitions } from "./tenant-api-agent-timer-tools.js";
import { whereAmI } from "./whereiam.js";
import {
  createUserSkillForPrincipal,
  deleteUserSkillForPrincipal,
  getUserSkillForPrincipal,
  listUserSkillsForPrincipal,
  searchUserSkillsForPrincipal,
  setUserSkillForPrincipal,
  userScopedCapabilityHints,
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

function safeUrl(value = "") {
  const text = clean(value);
  return /^(https?:|\/)/i.test(text) ? text.slice(0, 1000) : "";
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

function safeLease(lease = null) {
  if (!lease || typeof lease !== "object") return null;
  return {
    desktopSlug: clean(lease.desktopSlug),
    ownerUserId: clean(lease.ownerUserId),
    threadId: clean(lease.threadId),
    threadName: clean(lease.threadName || lease.ownerThreadLabel),
    mode: clean(lease.mode),
    stale: lease.stale === true,
    stealable: lease.stealable === true,
    acquiredAt: clean(lease.acquiredAt),
    heartbeatAt: clean(lease.heartbeatAt),
    expiresAt: clean(lease.expiresAt),
  };
}

function desktopActions(session = {}) {
  const control = session.control && typeof session.control === "object" ? session.control : {};
  const actions = new Set(["status"]);
  const openUrl = safeUrl(session.desk_url || session.url);
  if (openUrl || control.start === true) actions.add("open");
  if (control.prepare === true || control.health === true) actions.add("prepare");
  if (control.start === true) actions.add("start");
  if (control.stop === true) actions.add("stop");
  if (control.restart === true) actions.add("restart");
  if (control.start === true) actions.add("open_url");
  return [...actions];
}

function publicDesktopRecord(session = {}) {
  const slug = clean(session.slug || session.id);
  return {
    slug,
    id: slug,
    label: clean(session.label || slug || "Desktop"),
    type: clean(session.type || "desktop"),
    access: clean(session.access || "desktop"),
    state: clean(session.state || session.status || "unknown"),
    status: clean(session.status || session.state || "unknown"),
    url: safeUrl(session.desk_url || session.url),
    availableActions: desktopActions(session),
    control: {
      prepare: session.control?.prepare === true || session.control?.health === true,
      start: session.control?.start === true,
      stop: session.control?.stop === true,
      restart: session.control?.restart === true,
    },
    lease: safeLease(session.lease),
    leased: session.leased === true,
    leaseOwnerThreadId: clean(session.leaseOwnerThreadId),
    leaseOwnerLabel: clean(session.leaseOwnerLabel),
    notes: clean(session.notes || session.purpose).slice(0, 1000),
    source: clean(session.source),
  };
}

async function safeDesktopInventory(principal = {}, env = process.env) {
  try {
    const payload = await listBrowserSessions(env, { principal });
    return {
      ok: payload?.ok !== false,
      source: clean(payload?.source),
      error: clean(payload?.error),
      message: clean(payload?.message),
      desktops: (payload?.sessions || []).map(publicDesktopRecord).filter((desktop) => desktop.slug),
    };
  } catch (error) {
    return {
      ok: false,
      source: "browser",
      error: clean(error?.message || error || "desktop_inventory_failed"),
      message: clean(error?.message || error || "Desktop inventory failed."),
      desktops: [],
    };
  }
}

function skillActionNames(skill = {}, capabilities = {}, desktops = null) {
  const id = clean(skill.id).toLowerCase();
  if (!skillAvailableFromCapabilities(skill, capabilities)) return ["status"];
  if (id === "whereiam") return ["status"];
  if (id === "files") return capabilities.files === true ? ["list", "read", "write"] : ["status"];
  if (id === "timers") return capabilities.timers === true ? ["list", "create", "delete", "run"] : ["status"];
  if (["gmail", "outlook", "jira", "shopify", "whatsapp"].includes(id)) return ["status"];
  if (clean(skill.requiresDesktop)) {
    if (!desktops) return ["status", "list_actions"];
    const desktop = desktops.find((item) => item.slug === clean(skill.requiresDesktop));
    return desktop ? desktop.availableActions : ["status"];
  }
  return ["status"];
}

function skillAvailableFromCapabilities(skill = {}, capabilities = {}) {
  if (skill.enabled !== true) return false;
  const id = clean(skill.id).toLowerCase();
  const connector = clean(skill.requiresConnector).toLowerCase();
  const scopedConnectors = capabilities.scopedConnectors && typeof capabilities.scopedConnectors === "object" ? capabilities.scopedConnectors : {};
  if (connector) return scopedConnectors[connector] === true && capabilities[connector] === true;
  if (clean(skill.requiresDesktop)) return capabilities.desktopLeases === true || capabilities.virtualBrowsers === true || capabilities.linkedin === true;
  if (id === "files") return capabilities.files === true;
  if (id === "timers") return capabilities.timers === true;
  if (id === "whatsapp") return capabilities.whatsapp === true;
  if (id === "gmail") return capabilities.gmail === true;
  if (id === "outlook") return capabilities.outlook === true;
  if (id === "linkedin") return capabilities.linkedin === true || capabilities.desktopLeases === true || capabilities.virtualBrowsers === true;
  if (id === "learning") return capabilities.learning === true;
  return true;
}

async function skillActionInventory(principal = {}, thread = null, env = process.env, options = {}) {
  const userId = principalUserId(principal);
  const listed = await listUserSkillsForPrincipal(userId, principal, env);
  const capabilities = await userScopedCapabilityHints({ userId, thread }, env);
  const skillFilter = clean(options.skillId).toLowerCase();
  const desktopInventory = options.includeDesktopInventory === true ? await safeDesktopInventory(principal, env) : null;
  const desktops = desktopInventory?.desktops || null;
  const skills = listed.skills
    .filter((skill) => !skillFilter || skill.id === skillFilter)
    .map((skill) => {
      const requiredDesktop = clean(skill.requiresDesktop);
      const matchingDesktop = requiredDesktop && desktops ? desktops.find((desktop) => desktop.slug === requiredDesktop) || null : null;
      const registryEnabled = skill.enabled === true;
      const capabilityAvailable = skillAvailableFromCapabilities(skill, capabilities);
      const available = capabilityAvailable && (!requiredDesktop || !desktops || Boolean(matchingDesktop));
      const unavailableReason = available
        ? ""
        : !registryEnabled
          ? "skill_disabled"
          : requiredDesktop && desktops && !matchingDesktop
            ? "desktop_not_available"
            : "capability_not_available";
      return {
        ...skill,
        registryEnabled,
        available,
        enabled: capabilityAvailable,
        setupState: available ? "available" : unavailableReason,
        availableActions: skillActionNames(skill, capabilities, desktops),
        actionTool: "orkestr_run_skill_action",
        ...(requiredDesktop ? {
          requiredDesktop,
          desktops: matchingDesktop ? [matchingDesktop] : [],
        } : {}),
      };
    });
  return {
    ok: true,
    userId,
    skills,
    enabledSkills: capabilities.enabledSkills || [],
    disabledSkills: capabilities.disabledSkills || [],
    availableSkills: skills.filter((skill) => skill.available).map((skill) => skill.id),
    desktopInventory: desktopInventory ? {
      ok: desktopInventory.ok,
      source: desktopInventory.source,
      error: desktopInventory.error,
      message: desktopInventory.message,
      desktops: desktopInventory.desktops,
    } : undefined,
    generatedAt: new Date().toISOString(),
  };
}

async function runSkillAction(args = {}, principal = {}, thread = null, env = process.env, fetchImpl = fetch) {
  const skillId = clean(args.skillId).toLowerCase();
  const action = clean(args.action).toLowerCase();
  if (!skillId) {
    const error = new Error("skill_id_required");
    error.statusCode = 400;
    throw error;
  }
  if (!action) {
    const error = new Error("skill_action_required");
    error.statusCode = 400;
    throw error;
  }
  const inventory = await skillActionInventory(principal, thread, env, { skillId, includeDesktopInventory: true });
  const skill = inventory.skills[0] || null;
  if (!skill) {
    const error = new Error("skill_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (action === "status" || action === "list_actions") return { ok: true, action, skill, desktopInventory: inventory.desktopInventory };
  if (clean(skill.requiresDesktop)) {
    const slug = clean(args.target || args.slug || skill.requiredDesktop || skill.requiresDesktop);
    const desktop = (inventory.desktopInventory?.desktops || []).find((item) => item.slug === slug) || null;
    if (!desktop) return { ok: false, error: "desktop_not_available", action, skill, desktopInventory: inventory.desktopInventory };
    if (!desktop.availableActions.includes(action)) return { ok: false, error: "skill_action_not_available", action, skill, desktop };
    let result;
    if (action === "prepare") result = await prepareVirtualBrowser(slug, env, { principal });
    else if (action === "start") result = await openVirtualBrowser(slug, env, "", { principal });
    else if (action === "open") {
      if (desktop.url && !desktop.availableActions.includes("start")) {
        return { ok: true, action, skill, desktop, message: "Desktop is already available.", url: desktop.url };
      }
      result = await openVirtualBrowser(slug, env, "", { principal });
    } else if (action === "open_url") {
      result = await openUrlInVirtualBrowser(slug, args.url, env, { principal });
    } else if (action === "stop") result = await stopVirtualBrowser(slug, env, { principal });
    else if (action === "restart") result = await restartVirtualBrowser(slug, env, { principal });
    else return { ok: false, error: "skill_action_not_implemented", action, skill, desktop };
    return {
      ok: true,
      action,
      skill: { ...skill, desktops: undefined },
      desktop: publicDesktopRecord(result),
      url: safeUrl(result?.desk_url || result?.url),
      openedUrl: safeUrl(result?.openedUrl),
      message: "Skill action completed.",
    };
  }
  return { ok: false, error: "skill_action_not_available", action, skill };
}

async function assertConnectorConnected(provider = "", principal = {}, env = process.env) {
  const status = await connectorAuthStatus(provider, env, { principal });
  if (status.connected !== true) {
    const error = new Error(`${provider}_not_connected`);
    error.statusCode = 403;
    throw error;
  }
  return status;
}

function publicGmailMessage(message = {}, options = {}) {
  const includeText = options.includeText === true;
  return {
    id: clean(message.id),
    threadId: clean(message.threadId),
    subject: clean(message.subject),
    from: clean(message.from),
    to: clean(message.to),
    date: clean(message.date),
    internalDate: clean(message.internalDate),
    snippet: clean(message.snippet).slice(0, 1000),
    labelIds: Array.isArray(message.labelIds) ? message.labelIds.slice(0, 20).map(clean).filter(Boolean) : [],
    ...(includeText ? { text: safeText(message.text, 20_000) } : {}),
  };
}

async function searchGmail(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  await assertConnectorConnected("gmail", principal, env);
  const maxResults = Math.max(1, Math.min(10, Number(args.maxResults) || 5));
  const listed = await listGmailMessages({
    maxResults,
    query: clean(args.query),
  }, env, fetchImpl, { principal });
  const messages = [];
  for (const item of (listed.messages || []).slice(0, maxResults)) {
    const id = clean(item.id);
    if (!id) continue;
    const message = await getGmailMessage(id, env, fetchImpl, { principal });
    messages.push(publicGmailMessage(message));
  }
  return {
    ok: true,
    provider: "gmail",
    query: clean(args.query),
    resultSizeEstimate: listed.resultSizeEstimate || messages.length,
    nextPageToken: clean(listed.nextPageToken),
    messages,
  };
}

async function readGmailMessage(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  await assertConnectorConnected("gmail", principal, env);
  const message = await getGmailMessage(args.messageId, env, fetchImpl, { principal });
  return {
    ok: true,
    provider: "gmail",
    message: publicGmailMessage(message, { includeText: true }),
  };
}

async function readLatestGmailMessage(args = {}, principal = {}, env = process.env, fetchImpl = fetch) {
  await assertConnectorConnected("gmail", principal, env);
  const listed = await listGmailMessages({
    maxResults: 1,
    query: clean(args.query),
  }, env, fetchImpl, { principal });
  const id = clean(listed.messages?.[0]?.id);
  if (!id) {
    return {
      ok: true,
      provider: "gmail",
      query: clean(args.query),
      message: null,
      resultSizeEstimate: listed.resultSizeEstimate || 0,
    };
  }
  const message = await getGmailMessage(id, env, fetchImpl, { principal });
  return {
    ok: true,
    provider: "gmail",
    query: clean(args.query),
    message: publicGmailMessage(message, { includeText: true }),
    resultSizeEstimate: listed.resultSizeEstimate || 1,
  };
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
      description: "List this user's Orkestr skills, whether each skill is enabled and currently available, and the generic actions each skill may expose. Use this when the user asks what skills or capabilities are available.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    ...tenantApiAgentProfileToolDefinitions(),
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
      name: "orkestr_list_skill_actions",
      description: "Inspect live action availability for one skill, including related desktops when a skill needs a managed desktop. Use this before answering action questions such as whether a skill can open, start, stop, or inspect something.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id to inspect, or empty string to inspect all skills." },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_run_skill_action",
      description: "Run a generic action exposed by an enabled tenant skill. Use only after inspecting skill actions. For managed desktop skills this can start/open/stop/restart the tenant desktop when allowed.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id, for example linkedin." },
          action: { type: "string", enum: ["status", "list_actions", "prepare", "open", "start", "stop", "restart", "open_url"], description: "Action to run." },
          target: { type: "string", description: "Optional target resource such as a desktop slug, or empty string to use the skill default." },
          url: { type: "string", description: "Optional URL for open_url actions, otherwise empty string." },
        },
        required: ["skillId", "action", "target", "url"],
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
    ...tenantApiAgentTimerToolDefinitions(),
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
      name: "orkestr_search_gmail",
      description: "Search or list this user's scoped Gmail messages. Returns safe metadata and snippets, not full message bodies. Use this when Gmail capability is true and the user asks for latest mail, unread mail, or a Gmail search.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query. Use an empty string for latest messages." },
          maxResults: { type: "number", description: "Maximum messages to return, 1 to 10." },
        },
        required: ["query", "maxResults"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_gmail_message",
      description: "Read one full scoped Gmail message by id for this user. Use after orkestr_search_gmail when the user asks to open, read, or summarize a specific or latest message.",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "Gmail message id returned by orkestr_search_gmail." },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_latest_gmail_message",
      description: "Read the latest full scoped Gmail message matching an optional Gmail query. Use this directly when Gmail capability is true and the user asks to read or summarize the latest, most recent, unread, or searched email.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional Gmail search query. Use an empty string for the latest message overall." },
        },
        required: ["query"],
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
    return skillActionInventory(principal, thread, env, { includeDesktopInventory: false });
  }
  const profileTool = await runTenantApiAgentProfileTool(tool, args, { principal }, env);
  if (profileTool.handled) return profileTool.result;
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
  if (tool === "orkestr_list_skill_actions") {
    return skillActionInventory(principal, thread, env, { skillId: args.skillId, includeDesktopInventory: true });
  }
  if (tool === "orkestr_run_skill_action") {
    return runSkillAction(args, principal, thread, env, context.fetchImpl || fetch);
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
  const timerTool = await runTenantApiAgentTimerTool(tool, args, { principal, thread }, env);
  if (timerTool.handled) return timerTool.result;
  if (tool === "orkestr_start_connector_auth") {
    return startConnectorAuth(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_connector_status") {
    return connectorAuthStatus(args.provider, env, { principal });
  }
  if (tool === "orkestr_search_gmail") {
    return searchGmail(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_read_gmail_message") {
    return readGmailMessage(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_read_latest_gmail_message") {
    return readLatestGmailMessage(args, principal, env, context.fetchImpl || fetch);
  }
  if (tool === "orkestr_disconnect_connector") {
    return disconnectConnectorAuth(args, principal, env);
  }
  const error = new Error("api_agent_tool_not_allowed");
  error.statusCode = 403;
  throw error;
}
