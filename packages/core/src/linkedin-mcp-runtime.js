import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireDesktopLease, heartbeatDesktopLease, releaseDesktopLease } from "../../browsers/src/desktop-leases.js";
import { operateManagedDesktop } from "../../browsers/src/desktop-operator.js";

function clean(value) {
  return String(value || "").trim();
}

function bool(value, fallback = false) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function moduleSpecifier(value = "") {
  const raw = clean(value);
  if (!raw) return "ork-linkedin";
  if (raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("file:")) {
    return raw.startsWith("file:") ? raw : pathToFileURL(path.resolve(raw)).href;
  }
  return raw;
}

function runtimeError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function loadLinkedInRuntimeModule(options = {}) {
  if (options.linkedinModule) return options.linkedinModule;
  const specifier = moduleSpecifier(options.modulePath || options.env?.ORKESTR_LINKEDIN_MODULE || options.env?.ORKESTR_LINKEDIN_RUNTIME_MODULE);
  try {
    const loaded = await import(specifier);
    if (typeof loaded.createLinkedInMcpServer !== "function" || typeof loaded.createLinkedInRuntimeHandlers !== "function") {
      throw runtimeError("ork_linkedin_module_missing_runtime_exports");
    }
    return loaded;
  } catch (error) {
    if (String(error?.message || "") === "ork_linkedin_module_missing_runtime_exports") throw error;
    throw runtimeError(`ork_linkedin_module_unavailable:${specifier}`, 409);
  }
}

export async function readLinkedInMcpPlan(planPath) {
  const filePath = clean(planPath);
  if (!filePath) throw runtimeError("linkedin_mcp_plan_required", 400);
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(parsed?.calls)) throw runtimeError("linkedin_mcp_plan_calls_required", 400);
  return parsed;
}

export function createOrkestrLinkedInDesktopAdapter(options = {}) {
  const env = options.env || process.env;
  const desktopSlug = clean(options.desktopSlug || env.ORKESTR_LINKEDIN_DESKTOP_SLUG || "linkedin");
  const threadId = clean(options.threadId);
  const ownerUserId = clean(options.ownerUserId);
  const operate = options.operateManagedDesktopFn || operateManagedDesktop;
  const heartbeat = options.heartbeatDesktopLeaseFn || heartbeatDesktopLease;

  async function heartbeatLease() {
    if (!threadId) return null;
    return heartbeat(desktopSlug, threadId, env, { principal: options.principal, ownerUserId }).catch(() => null);
  }

  async function observe(action = {}, context = {}) {
    await heartbeatLease();
    const observed = await operate(
      desktopSlug,
      {
        operation: "observe",
        maxText: options.maxText || env.ORKESTR_LINKEDIN_OBSERVE_MAX_TEXT || 8000,
        waitMs: options.waitMs || env.ORKESTR_LINKEDIN_OBSERVE_WAIT_MS || 750,
      },
      env,
      { principal: options.principal, ownerUserId },
    );
    const page = observed?.page || {};
    return {
      ok: observed?.ok !== false,
      events: [
        {
          endpoint: clean(page.url),
          pageText: clean(page.bodyText),
          visibleText: clean(page.bodyText),
          status: 0,
        },
      ],
      items: [],
      evidence: {
        action: action.type || context.tool?.name || "",
        desktop: observed?.desktop || { slug: desktopSlug },
        page: {
          title: clean(page.title),
          url: clean(page.url),
          textLength: Number(page.textLength || 0) || clean(page.bodyText).length,
          links: Array.isArray(page.links) ? page.links.slice(0, 12) : [],
          buttons: Array.isArray(page.buttons) ? page.buttons.slice(0, 20) : [],
          fields: Array.isArray(page.fields) ? page.fields.slice(0, 12) : [],
        },
      },
    };
  }

  async function perform(action = {}, context = {}) {
    await heartbeatLease();
    const approvals = Array.isArray(action?.input?.approvals) ? action.input.approvals : [];
    if (options.acceptPreverifiedWrites === true) {
      const verified = approvals.filter((approval) => approval.verified === true || approval.verifiedSend === true);
      if (verified.length) {
        return {
          ok: true,
          items: verified.map((approval) => ({ ...approval, verified: true, verifiedSend: true })),
          events: [],
          evidence: {
            action: action.type || context.tool?.name || "",
            verificationSource: "preverified_visible_evidence",
          },
        };
      }
    }
    return {
      ok: false,
      items: approvals.map((approval) => ({
        candidateId: approval.candidateId,
        approved: approval.approved === true,
        verified: false,
        manualRequired: true,
      })),
      events: [],
      evidence: {
        action: action.type || context.tool?.name || "",
        code: "LINKEDIN_VISIBLE_MANUAL_SEND_REQUIRED",
        reason:
          "Orkestr will not automate LinkedIn write actions through CDP/DevTools. Send manually in the visible desktop or provide verified visible-send evidence.",
      },
    };
  }

  return { observe, perform };
}

function planRunId(plan = {}, options = {}) {
  return clean(options.runId || plan.runId || `linkedin-mcp-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}`);
}

function planDesktopSlug(plan = {}, options = {}) {
  return clean(options.desktopSlug || plan.desktopSlug || options.env?.ORKESTR_LINKEDIN_DESKTOP_SLUG || "linkedin");
}

function planThreadId(plan = {}, options = {}, runId = "") {
  return clean(options.threadId || plan.threadId || `linkedin-runtime-${runId}`);
}

export async function executeLinkedInMcpPlan(plan = {}, options = {}) {
  if (!Array.isArray(plan?.calls)) throw runtimeError("linkedin_mcp_plan_calls_required", 400);
  const env = options.env || process.env;
  const runId = planRunId(plan, options);
  const desktopSlug = planDesktopSlug(plan, { ...options, env });
  const threadId = planThreadId(plan, options, runId);
  const threadName = clean(options.threadName || plan.threadName || `LinkedIn MCP Runtime ${runId}`);
  const ownerUserId = clean(options.ownerUserId || plan.ownerUserId || "");
  const leaseFns = {
    acquireDesktopLeaseFn: options.acquireDesktopLeaseFn || acquireDesktopLease,
    releaseDesktopLeaseFn: options.releaseDesktopLeaseFn || releaseDesktopLease,
    heartbeatDesktopLeaseFn: options.heartbeatDesktopLeaseFn || heartbeatDesktopLease,
  };

  let lease = null;
  if (options.acquireLease !== false) {
    const acquired = await leaseFns.acquireDesktopLeaseFn(
      desktopSlug,
      {
        threadId,
        threadName,
        ownerUserId,
        mode: "exclusive",
        purpose: "linkedin_mcp_runtime",
        runId,
        ttlMs: options.leaseTtlMs || env.ORKESTR_LINKEDIN_RUNTIME_LEASE_TTL_MS || 30 * 60_000,
        force: options.forceLease === true,
      },
      env,
      { principal: options.principal, ownerUserId },
    );
    if (!acquired?.ok) {
      return {
        ok: false,
        runId,
        desktopSlug,
        threadId,
        error: acquired?.error || "desktop_lease_failed",
        lease: acquired?.lease || null,
        results: [],
      };
    }
    lease = acquired.lease || null;
  }

  const linkedin = await loadLinkedInRuntimeModule({ ...options, env });
  const desktop = options.desktopAdapter || createOrkestrLinkedInDesktopAdapter({
    ...options,
    env,
    desktopSlug,
    threadId,
    ownerUserId,
    heartbeatDesktopLeaseFn: leaseFns.heartbeatDesktopLeaseFn,
  });
  const server = linkedin.createLinkedInMcpServer({
    handlers: linkedin.createLinkedInRuntimeHandlers({ desktop }),
  });

  const results = [];
  let ok = true;
  try {
    for (const call of plan.calls) {
      const result = await server.callTool(call.tool, call.input || {}, {
        runId,
        plan,
        safety: call.safety || null,
      });
      results.push({
        tool: call.tool,
        ok: result.ok !== false,
        result,
      });
      if (result.ok === false || result.blocked === true) {
        ok = false;
        if (options.stopOnBlocker !== false) break;
      }
    }
  } finally {
    if (lease && options.releaseLease !== false) {
      await leaseFns.releaseDesktopLeaseFn(desktopSlug, {
        threadId,
        ownerUserId,
        reason: "linkedin_mcp_runtime_complete",
      }, env).catch(() => null);
    }
  }

  return {
    ok,
    contractVersion: plan.contractVersion || "linkedin.mcp.v1",
    runId,
    desktopSlug,
    threadId,
    lease,
    results,
  };
}

export function parseLinkedInRuntimeArgs(argv = [], env = process.env) {
  const options = {
    planPath: "",
    output: "",
    modulePath: clean(env.ORKESTR_LINKEDIN_MODULE || env.ORKESTR_LINKEDIN_RUNTIME_MODULE),
    desktopSlug: clean(env.ORKESTR_LINKEDIN_DESKTOP_SLUG || "linkedin"),
    threadId: "",
    threadName: "",
    ownerUserId: "",
    forceLease: false,
    releaseLease: true,
    stopOnBlocker: true,
    acceptPreverifiedWrites: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") options.planPath = clean(argv[++index]);
    else if (arg === "--output") options.output = clean(argv[++index]);
    else if (arg === "--module") options.modulePath = clean(argv[++index]);
    else if (arg === "--desktop") options.desktopSlug = clean(argv[++index]);
    else if (arg === "--thread-id") options.threadId = clean(argv[++index]);
    else if (arg === "--thread-name") options.threadName = clean(argv[++index]);
    else if (arg === "--owner-user-id") options.ownerUserId = clean(argv[++index]);
    else if (arg === "--force-lease") options.forceLease = true;
    else if (arg === "--no-release") options.releaseLease = false;
    else if (arg === "--continue-on-blocker") options.stopOnBlocker = false;
    else if (arg === "--accept-preverified-writes") options.acceptPreverifiedWrites = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.planPath) options.planPath = clean(arg);
    else throw runtimeError(`unknown_linkedin_runtime_arg:${arg}`, 2);
  }
  return options;
}

export async function writeLinkedInRuntimeResult(output, result) {
  const filePath = clean(output);
  if (!filePath) return;
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
