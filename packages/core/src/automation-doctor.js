import { listAutomationsForPrincipal } from "./automations.js";
import { listThreadsForPrincipal } from "./threads.js";

function clean(value = "") {
  return String(value || "").trim();
}

function statusFromIssues(issues = []) {
  if (issues.some((issue) => issue.severity === "error")) return "broken";
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return "ok";
}

function automationIssue(automation, severity, code, message, details = {}) {
  return {
    severity,
    code,
    message,
    automationId: automation?.automationId || null,
    automationLabel: automation?.label || null,
    automationType: automation?.type || null,
    target: automation?.target || null,
    targetType: automation?.targetType || null,
    details,
  };
}

function requiredConnectorForAutomation(automation = {}) {
  const explicit = clean(automation.requirements?.connector);
  if (explicit) return explicit.toLowerCase();
  if (automation.type === "gmail_notification") return "gmail";
  if ((automation.type === "push" || automation.type === "connector_push") && clean(automation.provider)) {
    return clean(automation.provider).toLowerCase();
  }
  return "";
}

async function inspectDesktopInventory(requiredDesktops, issues, options = {}) {
  if (!requiredDesktops.size) return null;
  if (typeof options.browserSessionsProvider !== "function") {
    issues.push(automationIssue(null, "warning", "desktop_inventory_unavailable", "Managed desktop inventory inspector is not available."));
    return null;
  }
  try {
    const inventory = await options.browserSessionsProvider();
    if (inventory?.ok === false) {
      issues.push(automationIssue(null, "error", "desktop_inventory_unavailable", "Managed desktop inventory could not be inspected.", {
        source: clean(inventory.source),
        error: clean(inventory.error || inventory.message),
      }));
    }
    return inventory;
  } catch (error) {
    issues.push(automationIssue(null, "error", "desktop_inventory_unavailable", "Managed desktop inventory could not be inspected.", {
      error: error?.message || String(error),
    }));
    return { ok: false, sessions: [] };
  }
}

async function connectorStatus(connector, principal, env, options = {}) {
  if (typeof options.connectorStatusProvider !== "function") {
    return {
      ok: false,
      state: "unknown",
      connected: false,
      error: "connector_status_inspector_unavailable",
    };
  }
  return options.connectorStatusProvider(connector, principal, env);
}

export async function doctorAutomationsForPrincipal(principal, env = process.env, now = new Date(), options = {}) {
  const nowMs = now.getTime();
  const graceMs = Number(options.graceMs || env.ORKESTR_AUTOMATION_DOCTOR_GRACE_MS || 2 * 60 * 1000);
  const safeGraceMs = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 2 * 60 * 1000;
  const issues = [];
  const automations = await listAutomationsForPrincipal(principal, env);
  let threadInventoryOk = true;
  const threads = await listThreadsForPrincipal(principal, env).catch((error) => {
    threadInventoryOk = false;
    issues.push(automationIssue(null, "warning", "thread_inventory_unavailable", "Thread inventory could not be inspected.", {
      error: error?.message || String(error),
    }));
    return [];
  });
  const threadKeys = new Set(threads.flatMap((thread) => [thread.id, thread.name, thread.bindingName].filter(Boolean).map(String)));
  const connectorStatusByProvider = new Map();
  const requiredDesktops = new Set();

  for (const automation of automations) {
    if (automation.enabled !== false && clean(automation.requirements?.desktop)) {
      requiredDesktops.add(clean(automation.requirements.desktop));
    }
  }

  const desktopInventory = await inspectDesktopInventory(requiredDesktops, issues, options);
  const sessionsBySlug = new Map((desktopInventory?.sessions || []).flatMap((session) => {
    const keys = [session.slug, session.id, session.name].map(clean).filter(Boolean);
    return keys.map((key) => [key, session]);
  }));

  for (const automation of automations) {
    const enabled = automation.enabled !== false;
    const nextRunAt = clean(automation.schedule?.nextRunAt);
    const nextMs = Date.parse(nextRunAt);
    const connector = requiredConnectorForAutomation(automation);
    const desktop = clean(automation.requirements?.desktop);

    if (automation.targetType === "thread" && clean(automation.target) && threadInventoryOk && !threadKeys.has(clean(automation.target))) {
      issues.push(automationIssue(automation, "error", "missing_thread_target", "Automation targets a thread that does not exist."));
    }

    if (enabled && !nextRunAt) {
      issues.push(automationIssue(automation, "error", "missing_next_run", "Enabled automation has no next scheduled run."));
    } else if (enabled && Number.isNaN(nextMs)) {
      issues.push(automationIssue(automation, "error", "invalid_next_run", "Enabled automation next run is not a valid timestamp.", {
        nextRunAt,
      }));
    } else if (enabled && nextMs + safeGraceMs < nowMs) {
      issues.push(automationIssue(automation, "error", "automation_overdue", "Enabled automation is overdue; the automation runner may not be processing work.", {
        nextRunAt,
        overdueMs: nowMs - nextMs,
      }));
    }

    if (enabled && connector) {
      if (!connectorStatusByProvider.has(connector)) {
        try {
          connectorStatusByProvider.set(connector, await connectorStatus(connector, principal, env, options));
        } catch (error) {
          connectorStatusByProvider.set(connector, {
            ok: false,
            state: "unknown",
            connected: false,
            error: error?.message || String(error),
          });
        }
      }
      const status = connectorStatusByProvider.get(connector);
      if (status?.ok === false) {
        issues.push(automationIssue(automation, "warning", "connector_status_unavailable", `${connector} connector status could not be inspected.`, {
          connector,
          error: clean(status.error),
        }));
      } else if (status?.connected === false) {
        const state = clean(status.state || "not_connected");
        const severity = state.includes("config") ? "error" : "warning";
        issues.push(automationIssue(automation, severity, "connector_not_connected", `${connector} connector is not connected for this automation.`, {
          connector,
          state,
        }));
      }
    }

    if (enabled && desktop) {
      const session = sessionsBySlug.get(desktop);
      const state = clean(session?.state || session?.status);
      if (!session) {
        issues.push(automationIssue(automation, "error", "desktop_not_available", "Required managed desktop is not visible for this Orkestr instance.", {
          desktop,
        }));
      } else if (session.configured === false || state === "not_prepared") {
        issues.push(automationIssue(automation, "error", "desktop_not_provisioned", "Required managed desktop is not provisioned yet.", {
          desktop,
          state,
        }));
      } else if (state && !["prepared", "running", "active", "open"].includes(state)) {
        issues.push(automationIssue(automation, "warning", "desktop_not_ready", "Required managed desktop is not ready.", {
          desktop,
          state,
        }));
      }
    }

    if (clean(automation.lastError)) {
      issues.push(automationIssue(automation, "warning", "last_automation_error", "Automation recorded a previous run error.", {
        lastError: clean(automation.lastError),
      }));
    }
  }

  const enabledAutomations = automations.filter((automation) => automation.enabled !== false);
  const dueAutomations = enabledAutomations.filter((automation) => {
    const nextMs = Date.parse(clean(automation.schedule?.nextRunAt));
    return Number.isFinite(nextMs) && nextMs <= nowMs;
  });
  const byType = {};
  for (const automation of automations) {
    const type = clean(automation.type || "unknown") || "unknown";
    byType[type] = (byType[type] || 0) + 1;
  }
  const status = statusFromIssues(issues);
  const counts = {
    total: automations.length,
    enabled: enabledAutomations.length,
    paused: automations.length - enabledAutomations.length,
    due: dueAutomations.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    byType,
  };
  const summary = status === "broken"
    ? `${counts.errors} automation problem${counts.errors === 1 ? "" : "s"} need attention.`
    : status === "warning"
      ? `${counts.warnings} automation warning${counts.warnings === 1 ? "" : "s"} found.`
      : `${counts.total} automation${counts.total === 1 ? "" : "s"} checked.`;
  return {
    ok: status !== "broken",
    status,
    summary,
    generatedAt: now.toISOString(),
    counts,
    issues,
  };
}
