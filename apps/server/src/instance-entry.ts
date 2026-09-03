import {
  readBrokerInstanceRegistry,
  resolveBrokerConnectInstance,
} from "../../../packages/core/src/broker-instance-registry.js";
import { explicitCanonicalAppBase } from "../../../packages/core/src/canonical-app-links.js";
import { parseInstancePublicRef } from "../../../packages/core/src/canonical-public-references.js";
import { readInstanceIdentity } from "../../../packages/core/src/instance-identity.js";
import { instanceSetupPairingRedirectPath } from "./instance-connect-setup.js";
import { publicPairingUrl } from "./public-site.js";

type InstanceEntryTarget = {
  internalInstanceId: string;
  publicRef: string;
};

type EntryDependencies = {
  readLocalIdentity?: typeof readInstanceIdentity;
  readRegistry?: typeof readBrokerInstanceRegistry;
  resolveBroker?: typeof resolveBrokerConnectInstance;
};

const attemptsByAddress = new Map<string, number[]>();

function clean(value: unknown): string {
  return String(value || "").trim();
}

function host(value = ""): string {
  const first = clean(value).split(",")[0] || "";
  try {
    return new URL(/^https?:\/\//i.test(first) ? first : `https://${first}`).host.toLowerCase();
  } catch {
    return "";
  }
}

function requestHost(request: any): string {
  return host(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "");
}

function appHost(env = process.env): string {
  return host(explicitCanonicalAppBase(env));
}

function requestAddress(request: any): string {
  const forwarded = clean(request?.headers?.["x-forwarded-for"]);
  return (forwarded.split(",")[0] || clean(request?.ip || request?.socket?.remoteAddress) || "unknown").replace(/^::ffff:/, "");
}

function entryRateLimited(request: any, now = Date.now()): boolean {
  const key = requestAddress(request);
  const windowMs = 10 * 60 * 1000;
  const attempts = (attemptsByAddress.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  attempts.push(now);
  attemptsByAddress.set(key, attempts);
  return attempts.length > 12;
}

export function normalizeInstanceAlias(value = ""): string {
  const normalized = clean(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f/\\?#]/.test(normalized)) return "";
  return normalized;
}

function configuredAliases(env = process.env): string[] {
  return [
    env.ORKESTR_INSTANCE_NAME,
    env.ORKESTR_SERVICE_NAME,
    ...clean(env.ORKESTR_INSTANCE_ALIASES).split(","),
  ].map(normalizeInstanceAlias).filter(Boolean);
}

function exactPublicRef(value = ""): string {
  try {
    return parseInstancePublicRef(clean(value));
  } catch {
    return "";
  }
}

export async function resolveInstanceEntry(
  rawIdentifier = "",
  env = process.env,
  dependencies: EntryDependencies = {},
): Promise<InstanceEntryTarget | null> {
  const readLocal = dependencies.readLocalIdentity || readInstanceIdentity;
  const readRegistry = dependencies.readRegistry || readBrokerInstanceRegistry;
  const resolveBroker = dependencies.resolveBroker || resolveBrokerConnectInstance;
  const [local, registry] = await Promise.all([
    readLocal(env).catch(() => null),
    readRegistry(env).catch(() => ({ instances: [] })),
  ]);
  const brokers = Array.isArray(registry?.instances) ? registry.instances : [];
  const publicRef = exactPublicRef(rawIdentifier);

  if (publicRef) {
    if (local?.publicRef === publicRef) {
      return { internalInstanceId: local.internalInstanceId, publicRef };
    }
    const matching = brokers.filter((record: any) => clean(record?.publicRef) === publicRef);
    if (matching.length !== 1) return null;
    const usable = await resolveBroker(clean(matching[0].instanceId), env).catch(() => null);
    return usable ? { internalInstanceId: clean(matching[0].instanceId), publicRef } : null;
  }

  const alias = normalizeInstanceAlias(rawIdentifier);
  if (!alias) return null;
  const candidates: InstanceEntryTarget[] = [];
  if (local?.publicRef && configuredAliases(env).includes(alias)) {
    candidates.push({ internalInstanceId: local.internalInstanceId, publicRef: local.publicRef });
  }
  for (const record of brokers) {
    if (!record?.publicRef || normalizeInstanceAlias(record.displayName) !== alias) continue;
    const usable = await resolveBroker(clean(record.instanceId), env).catch(() => null);
    if (usable) candidates.push({ internalInstanceId: clean(record.instanceId), publicRef: clean(record.publicRef) });
  }
  const unique = new Map(candidates.map((candidate) => [candidate.internalInstanceId, candidate]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function escapeHtml(value = ""): string {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderInstanceEntry(error = ""): string {
  const notice = error
    ? `<p class="notice" role="alert">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Which Orkestr?</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #070b07; color: #effff0; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: radial-gradient(circle at top left, #19351d, transparent 32rem), #070b07; }
    main { width: min(460px, calc(100% - 32px)); border: 1px solid #315438; border-radius: 16px; background: #0a120beF; padding: 28px; box-shadow: 0 24px 80px #0008; }
    p { color: #a9c5aa; line-height: 1.5; }
    h1 { margin: 6px 0 8px; font-size: 30px; letter-spacing: -.04em; }
    .eyebrow { margin: 0; color: #8cff9b; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    label { display: grid; gap: 8px; margin-top: 22px; color: #d9f2da; font-weight: 700; }
    input { width: 100%; min-height: 48px; border: 1px solid #456d4b; border-radius: 10px; background: #040805; color: #f2fff2; font: inherit; padding: 12px 14px; }
    input:focus { outline: 2px solid #63d47188; border-color: #63d471; }
    button { width: 100%; min-height: 46px; margin-top: 12px; border: 0; border-radius: 10px; background: #63d471; color: #061006; cursor: pointer; font: inherit; font-weight: 800; }
    .hint { margin-bottom: 0; font-size: 13px; }
    .notice { border: 1px solid #775b35; border-radius: 9px; background: #291d0c; color: #ffe0a3; padding: 10px 12px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Orkestr</p>
    <h1>Which Orkestr?</h1>
    <p>Enter the instance name or its <code>ins_…</code> ID. Orkestr will not show an instance directory or choose one for you.</p>
    ${notice}
    <form method="post" action="/instance-entry" autocomplete="off">
      <label>Instance
        <input name="instance" required maxlength="120" autofocus autocapitalize="none" spellcheck="false" placeholder="Instance name or ins_… ID">
      </label>
      <button type="submit">Continue</button>
    </form>
    <p class="hint">Access is still verified in the next step. A name is only a routing hint.</p>
  </main>
</body>
</html>`;
}

function sendEntry(response: any, message = "", status = 200): boolean {
  response.status(status).header("cache-control", "no-store").type("text/html; charset=utf-8").send(renderInstanceEntry(message));
  return true;
}

export async function maybeHandleInstanceEntry(
  request: any,
  response: any,
  requestUrl: string,
  options: { authenticated?: boolean; env?: NodeJS.ProcessEnv; dependencies?: EntryDependencies } = {},
): Promise<boolean> {
  const env = options.env || process.env;
  const url = new URL(requestUrl || "/", "http://localhost");
  if (!appHost(env) || requestHost(request) !== appHost(env)) return false;
  if (!["/", "/instance-entry"].includes(url.pathname)) return false;
  if (String(request?.method || "GET").toUpperCase() !== "POST") return sendEntry(response);
  if (entryRateLimited(request)) return sendEntry(response, "That instance could not be opened. Check the name or ID and try again.", 429);
  const target = await resolveInstanceEntry(clean(request?.body?.instance), env, options.dependencies);
  if (!target) return sendEntry(response, "That instance could not be opened. Check the name or ID and try again.");
  const pairing = publicPairingUrl(env);
  if (!pairing) return sendEntry(response, "That instance could not be opened. Check the name or ID and try again.");
  const returnPath = `/instance/${encodeURIComponent(target.publicRef)}/launcher`;
  const redirect = new URL(instanceSetupPairingRedirectPath(target.internalInstanceId, returnPath), pairing);
  response.status(303).header("cache-control", "no-store").header("location", redirect.toString()).send("Continue to Orkestr access.");
  return true;
}
