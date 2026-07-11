import path from "node:path";
import { normalizeTenantControlPlane, publicTenantControlPlane } from "./tenant-control-plane.js";
import { normalizeTenantVm } from "./tenant-vm-registry.js";

const defaultWorkspaceRoot = "/opt/orkestr/workspace";
const defaultCodexModel = "gpt-5.5";
const defaultCodexReasoningEffort = "medium";

function clean(value = "") {
  return String(value || "").trim();
}

function cleanObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeId(value = "", fallback = "tenant") {
  const id = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return id || fallback;
}

function titleFromSlug(value = "") {
  return safeId(value, "desk")
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Desk";
}

function stringList(values = []) {
  const input = Array.isArray(values) ? values : String(values || "").split(",");
  return [...new Set(input.map((value) => clean(value)).filter(Boolean))];
}

function safeWorkspacePath(value = "", fallback = "") {
  const raw = clean(value || fallback);
  if (!raw || raw.includes("\0") || !raw.startsWith("/")) return fallback;
  const normalized = path.posix.normalize(raw);
  return normalized.startsWith("/") ? normalized : fallback;
}

function safeUrl(value = "", { allowAboutBlank = false, localOnly = false } = {}) {
  const raw = clean(value);
  if (!raw) return "";
  if (allowAboutBlank && raw === "about:blank") return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return "";
  if (parsed.username || parsed.password) return "";
  if (localOnly) {
    const host = parsed.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return "";
  }
  return parsed.toString();
}

function normalizeReasoningEffort(value = "") {
  const effort = clean(value).toLowerCase();
  return new Set(["none", "minimal", "low", "medium", "high", "xhigh"]).has(effort)
    ? effort
    : defaultCodexReasoningEffort;
}

function defaultSkillIds(vm) {
  const capabilities = new Set(vm.capabilities || []);
  const skills = ["whereiam", "files", "timers", "learning"];
  if (capabilities.has("whatsapp")) skills.push("whatsapp");
  if (capabilities.has("gmail") || vm.connectors.gmailAccountId) skills.push("gmail");
  if (capabilities.has("outlook") || vm.connectors.outlookAccountId) skills.push("outlook");
  if (capabilities.has("desks") || vm.connectors.linkedinDesktopSlug) skills.push("linkedin");
  return skills;
}

function normalizeSkills(values = [], vm) {
  return stringList([...defaultSkillIds(vm), ...stringList(values)])
    .map((value) => safeId(value, "skill"))
    .filter(Boolean);
}

function normalizeDesks(values = [], vm) {
  const input = Array.isArray(values) ? values : stringList(values);
  const rows = input.length ? input : [{ slug: vm.connectors.linkedinDesktopSlug || "linkedin", connector: "linkedin" }];
  const seen = new Set();
  return rows
    .map((item) => {
      const source = typeof item === "string" ? { slug: item } : cleanObject(item);
      const slug = safeId(source.slug || source.id || source.name, "desk");
      if (seen.has(slug)) return null;
      seen.add(slug);
      return {
        slug,
        label: clean(source.label || source.title) || titleFromSlug(slug),
        connector: safeId(source.connector || (slug === "linkedin" ? "linkedin" : "desktop"), "desktop"),
        purpose: clean(source.purpose || source.notes || source.description),
        startUrl: safeUrl(source.startUrl || source.start_url || source.url, { allowAboutBlank: true }),
        url: safeUrl(source.deskUrl || source.desk_url || source.publicUrl || source.public_url),
        cdpUrl: safeUrl(source.cdpUrl || source.cdp_url || source.localCdpUrl || source.local_cdp_url, { localOnly: true }),
        workspacePath: safeWorkspacePath(source.workspacePath || source.workspace || source.runtimeWorkspace, ""),
        enabled: source.enabled !== false,
      };
    })
    .filter(Boolean);
}

function assertPublicBootstrapProfile(value, pathParts = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertPublicBootstrapProfile(item, [...pathParts, String(index)]);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/(token|secret|password|cookie|session)/i.test(key)) {
        const error = new Error("tenant_bootstrap_profile_contains_secret_key");
        error.statusCode = 400;
        error.path = [...pathParts, key].join(".");
        throw error;
      }
      assertPublicBootstrapProfile(item, [...pathParts, key]);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(value)) {
    const error = new Error("tenant_bootstrap_profile_contains_private_key");
    error.statusCode = 400;
    error.path = pathParts.join(".");
    throw error;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  if (parsed.username || parsed.password) {
    const error = new Error("tenant_bootstrap_profile_credentialed_url");
    error.statusCode = 400;
    error.path = pathParts.join(".");
    throw error;
  }
}

export function buildTenantBootstrapProfile(vmInput, input = {}, env = process.env) {
  const vm = normalizeTenantVm(vmInput, env);
  const controlPlane = normalizeTenantControlPlane(input.controlPlane || input.sharedControlPlane || {}, env, {
    defaultEnabled: Boolean(input.controlPlane || input.sharedControlPlane || input.tenantSliceId),
  });
  const inputBootstrap = cleanObject(input.bootstrap);
  const vmBootstrap = cleanObject(vm.bootstrap);
  const firstThreadName = clean(
    inputBootstrap.firstThreadName ||
    input.firstThreadName ||
    vmBootstrap.firstThreadName ||
    vm.connectors.whatsappChatName ||
    vm.displayName ||
    vm.ownerUserId ||
    "Orkestr",
  );
  const firstThreadId = safeId(inputBootstrap.firstThreadId || vmBootstrap.firstThreadId || firstThreadName, "first-chat");
  const workspaceRoot = safeWorkspacePath(
    inputBootstrap.workspacePath || input.workspacePath || vmBootstrap.workspacePath,
    `${defaultWorkspaceRoot}/${firstThreadId}`,
  );
  const profile = {
    schemaVersion: 1,
    generatedBy: "orkestr",
    tenantVmId: vm.id,
    ownerUserId: vm.ownerUserId,
    displayName: vm.displayName,
    workspace: {
      root: workspaceRoot,
      filesRoot: safeWorkspacePath(inputBootstrap.filesRoot || input.filesRoot, `${workspaceRoot}/files`),
    },
    codex: {
      provider: "codex",
      model: clean(inputBootstrap.codexModel || input.codexModel || vmBootstrap.codexModel || env.ORKESTR_TENANT_CODEX_MODEL) || defaultCodexModel,
      reasoningEffort: normalizeReasoningEffort(inputBootstrap.codexReasoningEffort || input.codexReasoningEffort || vmBootstrap.codexReasoningEffort || env.ORKESTR_TENANT_CODEX_REASONING),
      mode: clean(inputBootstrap.codexMode || input.codexMode || "code").toLowerCase() === "plan" ? "plan" : "code",
    },
    firstChat: {
      id: firstThreadId,
      name: firstThreadName,
      title: clean(inputBootstrap.firstThreadTitle || input.firstThreadTitle || firstThreadName),
      autoWake: inputBootstrap.autoWakeFirstThread !== false && input.autoWakeFirstThread !== false,
      whatsappChatName: clean(vm.connectors.whatsappChatName),
    },
    desks: normalizeDesks(inputBootstrap.desks || input.desks || vmBootstrap.desks, vm),
    skills: normalizeSkills(inputBootstrap.skills || inputBootstrap.learningSkills || input.skills || vmBootstrap.skills, vm),
    connectors: {
      whatsapp: {
        enabled: vm.capabilities.includes("whatsapp"),
        chatId: clean(vm.connectors.whatsappChatId),
        chatName: clean(vm.connectors.whatsappChatName),
        accountId: clean(vm.connectors.whatsappAccountId),
        routeMode: vm.connectors.whatsappRouteEnabled ? "control-plane-forward" : "local",
      },
      gmail: {
        enabled: vm.capabilities.includes("gmail") || Boolean(vm.connectors.gmailAccountId),
        accountId: clean(vm.connectors.gmailAccountId),
      },
      outlook: {
        enabled: vm.capabilities.includes("outlook") || Boolean(vm.connectors.outlookAccountId),
        accountId: clean(vm.connectors.outlookAccountId),
      },
      linkedin: {
        enabled: vm.capabilities.includes("desks") || Boolean(vm.connectors.linkedinDesktopSlug),
        desktopSlug: clean(vm.connectors.linkedinDesktopSlug || "linkedin"),
      },
    },
    controlPlane: publicTenantControlPlane(controlPlane),
    policy: {
      singleThreadLimit: true,
      sanitizerRequired: true,
      sanitizerFallback: false,
      boundary: "tenant-vm",
      sharedAuthorization: controlPlane.sharedAuthorization,
      sharedChallenges: controlPlane.sharedChallenges,
    },
  };
  assertPublicBootstrapProfile(profile);
  return profile;
}

export function tenantBootstrapProfileJson(vm, input = {}, env = process.env) {
  return `${JSON.stringify(buildTenantBootstrapProfile(vm, input, env), null, 2)}\n`;
}
