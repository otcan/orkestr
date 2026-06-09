import WebSocket from "ws";
import { managedDesktopAction, managedDesktopOpenUrl } from "./browserctl.js";

function clean(value) {
  return String(value || "").trim();
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function validateHttpUrl(value) {
  const raw = clean(value);
  if (!raw) {
    const error = new Error("desktop_url_required");
    error.statusCode = 400;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error("desktop_url_invalid");
    error.statusCode = 400;
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("desktop_url_unsupported_protocol");
    error.statusCode = 400;
    throw error;
  }
  return parsed.href;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function browserJson(baseUrl, path) {
  const response = await fetch(`${clean(baseUrl).replace(/\/+$/g, "")}${path}`);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(body || `desktop_cdp_http_${response.status}`);
    error.statusCode = response.status || 502;
    throw error;
  }
  return response.json();
}

async function pageTarget(cdpUrl) {
  const base = clean(cdpUrl).replace(/\/+$/g, "");
  if (!base) {
    const error = new Error("desktop_cdp_url_required");
    error.statusCode = 409;
    throw error;
  }
  const list = await browserJson(base, "/json/list").catch(() => []);
  const pages = Array.isArray(list) ? list.filter((item) => clean(item.type) === "page") : [];
  const existing = pages.find((item) => clean(item.webSocketDebuggerUrl)) || null;
  if (existing) return existing;
  const created = await fetch(`${base}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null);
  if (created?.webSocketDebuggerUrl) return created;
  const error = new Error("desktop_page_target_unavailable");
  error.statusCode = 409;
  throw error;
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.wsUrl);
    this.socket.on("message", (data) => this.handleMessage(data));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("desktop_cdp_connect_timeout")), 10_000);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  handleMessage(data) {
    let payload = null;
    try {
      payload = JSON.parse(String(data || ""));
    } catch {
      return;
    }
    if (!payload?.id || !this.pending.has(payload.id)) return;
    const { resolve, reject, timer } = this.pending.get(payload.id);
    clearTimeout(timer);
    this.pending.delete(payload.id);
    if (payload.error) reject(new Error(clean(payload.error.message) || "desktop_cdp_error"));
    else resolve(payload.result || {});
  }

  call(method, params = {}, timeoutMs = 15_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("desktop_cdp_not_connected"));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`desktop_cdp_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("desktop_cdp_closed"));
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // best effort
    }
  }
}

const OBSERVE_SCRIPT = String.raw`
(() => {
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const limit = (value, max) => text(value).slice(0, max);
  const visible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const cssPath = (el) => {
    if (!el || !el.tagName) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      const tag = node.tagName.toLowerCase();
      let index = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) index++;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const labelFor = (el) => {
    if (!el) return "";
    if (el.id) {
      const direct = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (direct) return text(direct.innerText || direct.textContent);
    }
    const wrapping = el.closest("label");
    if (wrapping) return text(wrapping.innerText || wrapping.textContent);
    return "";
  };
  const links = Array.from(document.querySelectorAll("a[href]"))
    .filter(visible)
    .slice(0, 40)
    .map((el) => ({ text: limit(el.innerText || el.textContent || el.getAttribute("aria-label"), 120), href: el.href, selector: cssPath(el) }));
  const fields = Array.from(document.querySelectorAll("input, textarea, select"))
    .filter(visible)
    .slice(0, 40)
    .map((el) => ({
      label: limit(labelFor(el) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.id, 120),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      placeholder: el.getAttribute("placeholder") || "",
      value: el.type === "password" ? "" : limit(el.value, 160),
      selector: cssPath(el),
    }));
  const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=button], input[type=submit], a[href]"))
    .filter(visible)
    .slice(0, 60)
    .map((el) => ({
      text: limit(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || el.title, 120),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      selector: cssPath(el),
    }))
    .filter((item) => item.text || item.selector);
  const bodyText = text(document.body ? document.body.innerText : "");
  return {
    title: document.title || "",
    url: location.href,
    bodyText: bodyText.slice(0, 8000),
    textLength: bodyText.length,
    links,
    fields,
    buttons,
  };
})()
`;

function clickScript(selector, text) {
  return `
(() => {
  const wantedSelector = ${JSON.stringify(clean(selector))};
  const wantedText = ${JSON.stringify(clean(text).toLowerCase())};
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const visible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  let el = wantedSelector ? document.querySelector(wantedSelector) : null;
  if (!el && wantedText) {
    const candidates = Array.from(document.querySelectorAll("button, [role=button], a[href], input[type=button], input[type=submit], label, [aria-label]")).filter(visible);
    el = candidates.find((item) => normalize(item.innerText || item.textContent || item.value || item.getAttribute("aria-label") || item.title).includes(wantedText)) || null;
  }
  if (!el) return { ok: false, error: "desktop_click_target_not_found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.click();
  return { ok: true, clicked: String(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || el.tagName || "").replace(/\\s+/g, " ").trim().slice(0, 200), url: location.href };
})()
`;
}

function typeScript(selector, target, value) {
  return `
(() => {
  const wantedSelector = ${JSON.stringify(clean(selector))};
  const wantedTarget = ${JSON.stringify(clean(target).toLowerCase())};
  const nextValue = ${JSON.stringify(String(value || ""))};
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const labelFor = (el) => {
    if (!el) return "";
    if (el.id) {
      const direct = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (direct) return direct.innerText || direct.textContent || "";
    }
    const wrapping = el.closest("label");
    return wrapping ? wrapping.innerText || wrapping.textContent || "" : "";
  };
  let el = wantedSelector ? document.querySelector(wantedSelector) : null;
  if (!el && wantedTarget) {
    const candidates = Array.from(document.querySelectorAll("input, textarea, select"));
    el = candidates.find((item) => normalize([labelFor(item), item.getAttribute("aria-label"), item.getAttribute("placeholder"), item.name, item.id].join(" ")).includes(wantedTarget)) || null;
  }
  if (!el) return { ok: false, error: "desktop_type_target_not_found" };
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  el.value = nextValue;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, field: String(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || el.id || el.tagName || "").slice(0, 200), url: location.href };
})()
`;
}

async function evaluateJson(client, expression) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    const error = new Error(clean(result.exceptionDetails.text) || "desktop_evaluate_failed");
    error.statusCode = 500;
    throw error;
  }
  return result?.result?.value ?? null;
}

function summarizeObservation(observed, maxText = 8000) {
  const page = observed && typeof observed === "object" ? observed : {};
  return {
    title: clean(page.title).slice(0, 300),
    url: clean(page.url),
    bodyText: clean(page.bodyText).slice(0, maxText),
    textLength: Number(page.textLength || 0) || clean(page.bodyText).length,
    links: Array.isArray(page.links) ? page.links.slice(0, 40) : [],
    fields: Array.isArray(page.fields) ? page.fields.slice(0, 40) : [],
    buttons: Array.isArray(page.buttons) ? page.buttons.slice(0, 60) : [],
  };
}

export async function operateManagedDesktop(slug = "", args = {}, env = process.env, options = {}) {
  const desktopSlug = clean(slug || args.slug || args.target);
  if (!desktopSlug) {
    const error = new Error("desktop_slug_required");
    error.statusCode = 400;
    throw error;
  }
  const operation = clean(args.operation || args.action || "observe").toLowerCase();
  const waitMs = clampInt(args.waitMs, 750, 0, 10_000);
  const maxText = clampInt(args.maxText, 8000, 500, 20_000);
  let session = null;

  if (operation === "navigate") {
    session = await managedDesktopOpenUrl(desktopSlug, validateHttpUrl(args.url), env, options);
  } else {
    session = await managedDesktopAction(desktopSlug, "start", env, options);
  }

  const cdpUrl = clean(session?.cdp_url);
  if (!cdpUrl) {
    return {
      ok: false,
      error: "desktop_cdp_unavailable",
      operation,
      desktop: { slug: desktopSlug, state: clean(session?.state || session?.status), label: clean(session?.label || desktopSlug) },
      message: "The desktop is open, but it does not expose a controllable browser endpoint.",
    };
  }

  const target = await pageTarget(cdpUrl);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.call("Page.enable").catch(() => null);
    await client.call("Runtime.enable").catch(() => null);
    let actionResult = { ok: true };
    if (operation === "click") {
      actionResult = await evaluateJson(client, clickScript(args.selector, args.text || args.targetText || args.label));
      await sleep(waitMs || 1000);
    } else if (operation === "type") {
      actionResult = await evaluateJson(client, typeScript(args.selector, args.target || args.label || args.field, args.value));
      await sleep(waitMs);
    } else if (operation === "navigate") {
      await sleep(waitMs || 1500);
    } else if (!["observe", "extract", "read"].includes(operation)) {
      return { ok: false, error: "desktop_operation_not_supported", operation };
    }
    const observed = summarizeObservation(await evaluateJson(client, OBSERVE_SCRIPT), maxText);
    return {
      ok: actionResult?.ok !== false,
      error: actionResult?.error || "",
      operation,
      actionResult,
      desktop: {
        slug: desktopSlug,
        label: clean(session?.label || desktopSlug),
        state: clean(session?.state || session?.status),
      },
      page: observed,
    };
  } finally {
    client.close();
  }
}
