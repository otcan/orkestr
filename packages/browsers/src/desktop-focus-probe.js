import { CdpClient } from "./desktop-operator.js";

// Read-only check of which page element has keyboard focus on a managed
// desktop, via Chrome DevTools (used before vault fill types a value). It only
// runs Runtime.evaluate on a side-effect-free expression; it never sends
// input, navigates or reads field values.

const PROBE_TIMEOUT_MS = 5_000;
const MAX_PAGES = 20;

const FOCUS_EXPRESSION = `(() => {
  if (!document.hasFocus()) return { focused: false };
  const el = document.activeElement;
  const tag = String(el && el.tagName || "").toLowerCase();
  const form = el && el.form ? el.form : null;
  return {
    focused: true,
    tag,
    type: tag === "input" ? String(el.type || "text").toLowerCase() : "",
    writable: !!el && !el.readOnly && !el.disabled,
    formHasPassword: !!(form && form.querySelector("input[type=password]")),
  };
})()`;

function clean(value) {
  return String(value ?? "").trim();
}

async function evaluateFocus(wsUrl) {
  const client = new CdpClient(wsUrl);
  try {
    await client.connect();
    const result = await client.call("Runtime.evaluate", { expression: FOCUS_EXPRESSION, returnByValue: true }, PROBE_TIMEOUT_MS);
    if (result?.exceptionDetails) throw new Error("desktop_focus_probe_failed");
    return result?.result?.value || { focused: false };
  } finally {
    client.close();
  }
}

/**
 * Returns `{ verified: true, field }` with the focused element of the one page
 * that has focus (`field` is null when no page has focus, e.g. the address
 * bar), or `{ verified: false }` when DevTools is unreachable.
 */
export async function probeFocusedField(cdpUrl) {
  const base = clean(cdpUrl).replace(/\/+$/g, "");
  if (!/^https?:\/\//.test(base)) return { verified: false };
  try {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return { verified: false };
    const list = await response.json();
    const pages = (Array.isArray(list) ? list : [])
      .filter((item) => clean(item?.type) === "page" && clean(item?.webSocketDebuggerUrl))
      .slice(0, MAX_PAGES);
    const focused = [];
    for (const page of pages) {
      const field = await evaluateFocus(page.webSocketDebuggerUrl);
      if (field?.focused) focused.push(field);
    }
    return { verified: true, field: focused.length === 1 ? focused[0] : null };
  } catch {
    return { verified: false };
  }
}

/**
 * "" when the focused field fits `expect` ("password", "username" or
 * "login-username": a username field in a form with a password field),
 * else a value-free refusal reason.
 */
export function focusRefusal(field, expect) {
  const input = field?.focused && field.tag === "input" && field.writable;
  if (expect === "password") return input && field.type === "password" ? "" : "focus_not_password_field";
  const username = input && ["text", "email"].includes(field.type);
  if (!username || (expect === "login-username" && !field.formHasPassword)) return "focus_not_username_field";
  return "";
}
