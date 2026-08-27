import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";
import { isAdminPrincipal } from "./policy.js";
import { readRuntimeSettings } from "./runtime-settings.js";

const DEFAULT_APPS = [
  {
    id: "threads",
    label: "Threads",
    category: "orkestr",
    type: "workspace",
    description: "Thread cockpit and agent work queues.",
    url: "/",
    tags: ["agents"],
  },
  {
    id: "desktops",
    label: "Desktops",
    category: "orkestr",
    type: "desktop",
    description: "Managed browser desktops for this instance.",
    url: "/desktops",
    tags: ["browser"],
  },
  {
    id: "files",
    label: "Files",
    category: "orkestr",
    type: "storage",
    description: "Instance-scoped workspace files.",
    url: "/files",
    tags: ["workspace"],
  },
  {
    id: "timers",
    label: "Timers",
    category: "orkestr",
    type: "automation",
    description: "Scheduled thread and connector work.",
    url: "/timers",
    tags: ["automation"],
  },
  {
    id: "connectors",
    label: "Connectors",
    category: "orkestr",
    type: "connector",
    description: "OAuth and messaging connector setup.",
    url: "/connectors",
    tags: ["accounts"],
  },
];

function clean(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function disabled(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["0", "false", "no", "n", "off", "disabled"].includes(normalized);
}

function safeSlug(value) {
  return clean(value, 120).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleFromSlug(slug) {
  return clean(slug, 80)
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 48)).filter(Boolean);
  return clean(value, 240).split(",").map((item) => clean(item, 48)).filter(Boolean);
}

function objectRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return [
    ...objectRows(value.items),
    ...objectRows(value.apps),
  ];
}

function parseJsonRows(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    return objectRows(JSON.parse(raw));
  } catch {
    return [];
  }
}

function launcherConfigFile(env = process.env) {
  const configured = clean(env.ORKESTR_APP_LAUNCHER_FILE, 1000);
  if (configured) return configured;
  return path.join(dataPaths(env).home, "app-launcher.json");
}

function safeLaunchUrl(value) {
  const raw = clean(value, 1000);
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeHealthUrl(value) {
  const raw = clean(value, 1000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function healthMethod(value) {
  const method = clean(value, 12).toUpperCase();
  return method === "GET" ? "GET" : "HEAD";
}

function normalizeApp(raw = {}, source = "config", index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const id = safeSlug(raw.id || raw.slug || raw.name || raw.label || `app-${index + 1}`);
  if (!id) return null;
  const url = safeLaunchUrl(raw.url || raw.launchUrl || raw.href || raw.path || raw.route);
  if (!url) return null;
  const type = safeSlug(raw.type || raw.kind || "web") || "web";
  const category = safeSlug(raw.category || raw.group || "apps") || "apps";
  const isExternal = /^https?:\/\//i.test(url);
  const enabled = raw.enabled !== false && raw.hidden !== true && !disabled(raw.status);
  return {
    id,
    slug: safeSlug(raw.slug || id) || id,
    label: clean(raw.label || raw.title || raw.name, 80) || titleFromSlug(id),
    description: clean(raw.description || raw.summary || "", 360),
    type,
    category,
    url,
    external: isExternal,
    target: clean(raw.target, 20) || (isExternal ? "_blank" : "_self"),
    tags: stringList(raw.tags).slice(0, 8),
    enabled,
    adminOnly: raw.adminOnly === true || raw.admin === true || clean(raw.scope).toLowerCase() === "admin",
    source,
    _healthUrl: safeHealthUrl(raw.healthUrl || raw.statusUrl || raw.probeUrl),
    _healthMethod: healthMethod(raw.healthMethod || raw.probeMethod),
  };
}

function publicApp(app) {
  const { _healthUrl, _healthMethod, ...rest } = app;
  return rest;
}

async function configuredRows(settings = {}, env = process.env) {
  const file = await readJson(launcherConfigFile(env), {}).catch(() => ({}));
  return [
    ...objectRows(settings.appLauncher).map((row) => ({ row, source: "runtime-settings" })),
    ...parseJsonRows(env.ORKESTR_APP_LAUNCHER_JSON).map((row) => ({ row, source: "env" })),
    ...objectRows(file).map((row) => ({ row, source: "file" })),
  ];
}

function defaultRows(settings = {}, env = process.env) {
  const disabledBySettings = settings.appLauncher?.includeDefaults === false;
  if (disabledBySettings || disabled(env.ORKESTR_APP_LAUNCHER_DEFAULTS)) return [];
  return DEFAULT_APPS;
}

async function probeHealth(app, env = process.env) {
  if (!app._healthUrl) return { status: "unknown", checkedAt: new Date().toISOString() };
  const timeoutMs = Math.max(250, Math.min(5000, Number(env.ORKESTR_APP_LAUNCHER_HEALTH_TIMEOUT_MS) || 1500));
  const started = Date.now();
  try {
    const response = await fetch(app._healthUrl, {
      method: app._healthMethod,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status >= 200 && response.status < 500 ? "ok" : "error",
      statusCode: response.status,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
      error: clean(error?.name || error?.message || error, 80),
    };
  }
}

function summarize(apps) {
  return {
    total: apps.length,
    internal: apps.filter((app) => !app.external).length,
    external: apps.filter((app) => app.external).length,
    available: apps.filter((app) => !app.health || app.health.status === "ok" || app.health.status === "unknown").length,
    attention: apps.filter((app) => app.health?.status === "error").length,
  };
}

export async function listLauncherApps(options = {}) {
  const env = options.env || process.env;
  const principal = options.principal || null;
  const includeHealth = options.includeHealth === true;
  const settings = await readRuntimeSettings(env).catch(() => ({}));
  const rows = [
    ...defaultRows(settings, env).map((row) => ({ row, source: "builtin" })),
    ...await configuredRows(settings, env),
  ];
  const appsBySlug = new Map();
  rows.forEach(({ row, source }, index) => {
    const app = normalizeApp(row, source, index);
    if (!app || !app.enabled) return;
    if (app.adminOnly && !isAdminPrincipal(principal)) return;
    appsBySlug.set(app.slug, app);
  });
  const apps = [...appsBySlug.values()].sort((left, right) => {
    const category = left.category.localeCompare(right.category);
    return category || left.label.localeCompare(right.label);
  });
  if (includeHealth) {
    await Promise.all(apps.map(async (app) => {
      app.health = await probeHealth(app, env);
    }));
  }
  const publicApps = apps.map(publicApp);
  return {
    ok: true,
    apps: publicApps,
    counts: summarize(publicApps),
    generatedAt: new Date().toISOString(),
  };
}

export { normalizeApp as normalizeLauncherApp };
