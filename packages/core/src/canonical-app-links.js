import {
  canonicalAppGatewayEnabled,
  parseInstancePublicRef,
  parseThreadPublicRef,
} from "./canonical-public-references.js";
import { readInstanceIdentity } from "./instance-identity.js";
import { publicUrlConfig } from "./public-url-config.js";

function enabled(value = "") {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}

export function canonicalAppLinksEnabled(env = process.env) {
  return canonicalAppGatewayEnabled(env) && enabled(env.ORKESTR_CANONICAL_APP_LINKS);
}

function routeTail(sourceUrl = "") {
  if (!sourceUrl) return { suffix: [], search: "", hash: "" };
  const parsed = new URL(String(sourceUrl), "https://orkestr.invalid");
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const threadIndex = parts.indexOf("thread");
  return {
    suffix: threadIndex >= 0 ? parts.slice(threadIndex + 2) : [],
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function canonicalThreadAppUrl({
  instancePublicRef = "",
  threadPublicRef = "",
  sourceUrl = "",
  panel = "",
} = {}, env = process.env) {
  if (!canonicalAppLinksEnabled(env)) return "";
  const instanceRef = parseInstancePublicRef(instancePublicRef);
  const threadRef = parseThreadPublicRef(threadPublicRef);
  const appHost = String(publicUrlConfig(env).appHost || "").trim().toLowerCase();
  if (!appHost) return "";
  const preserved = routeTail(sourceUrl);
  const suffix = panel ? [String(panel).trim()] : preserved.suffix;
  const target = new URL(`https://${appHost}`);
  const pathname = ["instance", instanceRef, "thread", threadRef, ...suffix]
    .map((part) => encodeURIComponent(part))
    .join("/");
  target.pathname = `/${pathname}`;
  target.search = preserved.search;
  target.hash = preserved.hash;
  return target.toString();
}

export async function canonicalThreadLink(thread = null, env = process.env, options = {}) {
  if (!canonicalAppLinksEnabled(env) || !thread?.publicRef) return "";
  const identity = Object.prototype.hasOwnProperty.call(options, "instanceIdentity")
    ? options.instanceIdentity
    : await readInstanceIdentity(env);
  if (!identity?.publicRef) return "";
  return canonicalThreadAppUrl({
    instancePublicRef: identity.publicRef,
    threadPublicRef: thread.publicRef,
    sourceUrl: options.sourceUrl || "",
    panel: options.panel || "",
  }, env);
}

export async function canonicalThreadLinkData(thread = null, env = process.env, options = {}) {
  const canonicalUrl = await canonicalThreadLink(thread, env, options);
  if (!canonicalUrl) return {};
  const parsed = new URL(canonicalUrl);
  return {
    canonicalUrl,
    canonicalPath: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}
