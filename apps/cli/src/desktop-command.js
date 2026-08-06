import { approveDesktopShareChallenge } from "../../../packages/core/src/desktop-shares.js";
import { readRuntimeSettings } from "../../../packages/core/src/runtime-settings.js";
import { requestJson } from "./api-client.js";

function clean(value) {
  return String(value || "").trim();
}

function positional(argv) {
  const values = [];
  const flagsWithValues = new Set(["--label"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (flagsWithValues.has(value)) {
      index += 1;
    } else if (!String(value || "").startsWith("--")) {
      values.push(value);
    }
  }
  return values;
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || "" : "";
}

function browserSessionSlug(session) {
  return clean(session?.slug || session?.id || session?.name).toLowerCase();
}

async function currentThreadContext(ctx) {
  const cwd = clean(ctx.cwd || ctx.env?.ORKESTR_CALLER_CWD || process.cwd());
  const payload = await requestJson(`/api/whereiam?cwd=${encodeURIComponent(cwd)}`, ctx).catch(() => null);
  return {
    threadId: clean(payload?.thread?.id),
    threadName: clean(payload?.thread?.displayName || payload?.thread?.title || payload?.thread?.name),
  };
}

async function browserSessionSlugs(ctx, threadId = "") {
  try {
    const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    const payload = await requestJson(`/api/browser-sessions${query}`, ctx);
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : payload?.browsers || [];
    return sessions.map(browserSessionSlug).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveDesktopSlug(explicit, ctx, threadId = "") {
  if (clean(explicit)) return clean(explicit).toLowerCase();
  const settings = await readRuntimeSettings(ctx.env).catch(() => ({}));
  const candidates = [
    settings?.desktops?.manualIntervention,
    settings?.desktops?.default,
  ].map(browserSessionSlug).filter(Boolean);
  const available = await browserSessionSlugs(ctx, threadId);
  const availableSet = new Set(available);
  return candidates.find((slug) => !availableSet.size || availableSet.has(slug))
    || available[0]
    || candidates[0]
    || "desktop";
}

function desktopShareText(payload = {}, slug = "") {
  const label = clean(payload?.share?.label || payload?.label || slug) || "desktop";
  const lines = [
    `Desktop link for ${label}:`,
    payload.url || "",
    "",
    "Open it on your phone, copy the exact Orkestr desktop approve command shown there, and paste that command back here.",
  ];
  const start = payload?.desktopStart;
  if (start?.requested && !start?.ok) {
    lines.push("", `Warning: desktop start failed: ${clean(start.error) || "desktop_start_failed"}`);
  }
  return lines.join("\n");
}

async function shareDesktop(argv, ctx) {
  const json = argv.includes("--json");
  const values = positional(argv);
  const thread = await currentThreadContext(ctx);
  const slug = await resolveDesktopSlug(values[0], ctx, thread.threadId);
  const body = {
    start: !argv.includes("--no-start"),
    threadId: thread.threadId,
  };
  if (thread.threadId && body.start) {
    const acquired = await requestJson(`/api/desktops/${encodeURIComponent(slug)}/acquire`, {
      ...ctx,
      method: "POST",
      body: {
        threadId: thread.threadId,
        threadName: thread.threadName,
        purpose: "desktop_share",
      },
    });
    body.fencingToken = clean(acquired?.lease?.fencingToken);
  }
  const label = flagValue(argv, "--label");
  if (label) body.label = label;
  const payload = await requestJson(`/api/desktops/${encodeURIComponent(slug)}/share`, {
    ...ctx,
    method: "POST",
    body,
  });
  const result = { ...payload, desktopSlug: payload?.share?.desktopSlug || slug };
  if (json) ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else ctx.stdout.write(`${desktopShareText(result, slug)}\n`);
  return 0;
}

async function approveDesktop(argv, ctx) {
  const json = argv.includes("--json");
  const challenge = positional(argv)[0];
  if (!challenge) throw new Error("Usage: orkestr desktop approve <challenge-id> [--json]");
  const payload = await approveDesktopShareChallenge(challenge, {
    env: ctx.env,
    approvedBy: "cli",
  });
  if (json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`Approved desktop access for ${payload.share?.desktopSlug || "desktop"}\n`);
  return 0;
}

export async function desktopCommand(argv, ctx) {
  const subcommand = argv[0]?.startsWith("--") ? "share" : argv[0] || "share";
  const rest = subcommand === "share" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  if (subcommand === "share" || subcommand === "open" || subcommand === "link") return shareDesktop(rest, ctx);
  if (subcommand === "approve") return approveDesktop(rest, ctx);
  throw new Error("Usage: orkestr desktop [share [slug]|approve <challenge-id>] [--json]");
}
