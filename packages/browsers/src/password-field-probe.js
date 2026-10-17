import { CdpClient } from "./desktop-operator.js";

// Password-blind, read-only check of one password field in one exact tab of a
// managed desktop (docs/password-handoff.md). It resolves the tab by its
// DevTools target id, requires the tab's origin to equal the expected origin
// exactly, and evaluates a fixed expression that returns booleans only. It
// never sends input, navigates, takes screenshots or reads a field's value
// or length.

const PROBE_TIMEOUT_MS = 5_000;

function clean(value) {
  return String(value ?? "").trim();
}

// `selector` is embedded as a JSON string literal, never as code.
function fieldExpression(selector) {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  let el = null;
  try { el = selector ? document.querySelector(selector) : document.querySelector("input[autocomplete~='new-password']"); } catch { el = null; }
  const input = !!el && String(el.tagName || "").toLowerCase() === "input";
  let chromeFilled = false;
  if (input) {
    try { chromeFilled = el.matches(":autofill"); } catch { try { chromeFilled = el.matches(":-webkit-autofill"); } catch { chromeFilled = false; } }
  }
  return {
    origin: location.origin,
    fieldFound: input,
    isPassword: input && String(el.type || "").toLowerCase() === "password",
    newPassword: input && /(^|\\s)new-password(\\s|$)/.test(String(el.getAttribute("autocomplete") || "")),
    filled: input && el.value !== "",
    chromeFilled: input && chromeFilled,
  };
})()`;
}

/** Exact origin of a URL, or "" when it has none (about:blank, data:, …). */
export function exactOrigin(url) {
  try {
    const origin = new URL(clean(url)).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

/**
 * `{ ok: true, field }` for the bound tab and field, or `{ ok: false, reason }`
 * with a value-free reason: devtools_unreachable, tab_not_found,
 * origin_mismatch, probe_failed.
 */
export async function probePasswordField(cdpUrl, { targetId, expectedOrigin, selector = "" } = {}, deps = {}) {
  const base = clean(cdpUrl).replace(/\/+$/g, "");
  const fetchImpl = deps.fetch || fetch;
  if (!/^https?:\/\//.test(base) || !clean(targetId) || !clean(expectedOrigin)) return { ok: false, reason: "devtools_unreachable" };
  let pages;
  try {
    const response = await fetchImpl(`${base}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: "devtools_unreachable" };
    pages = await response.json();
  } catch {
    return { ok: false, reason: "devtools_unreachable" };
  }
  const page = (Array.isArray(pages) ? pages : []).find((item) => clean(item?.id) === clean(targetId) && clean(item?.type) === "page");
  if (!page || !clean(page.webSocketDebuggerUrl)) return { ok: false, reason: "tab_not_found" };
  if (exactOrigin(page.url) !== clean(expectedOrigin)) return { ok: false, reason: "origin_mismatch" };
  const client = new CdpClient(page.webSocketDebuggerUrl);
  try {
    await client.connect();
    const result = await client.call("Runtime.evaluate", { expression: fieldExpression(clean(selector)), returnByValue: true }, PROBE_TIMEOUT_MS);
    const value = result?.result?.value;
    if (result?.exceptionDetails || !value || typeof value !== "object") return { ok: false, reason: "probe_failed" };
    // The page's own view of its origin must match too (no redirect race).
    if (clean(value.origin) !== clean(expectedOrigin)) return { ok: false, reason: "origin_mismatch" };
    return {
      ok: true,
      field: {
        found: value.fieldFound === true,
        isPassword: value.isPassword === true,
        newPassword: value.newPassword === true,
        filled: value.filled === true,
        chromeFilled: value.chromeFilled === true,
      },
    };
  } catch {
    return { ok: false, reason: "probe_failed" };
  } finally {
    client.close();
  }
}
