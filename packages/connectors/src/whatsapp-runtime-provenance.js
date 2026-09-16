import crypto from "node:crypto";

const opaqueReferences = new WeakMap();

function clean(value = "") {
  return String(value || "").trim();
}

function opaqueReference(value, prefix) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return "";
  let id = opaqueReferences.get(value);
  if (!id) {
    id = `${prefix}_${crypto.randomUUID()}`;
    opaqueReferences.set(value, id);
  }
  return id;
}

export function attestWhatsAppRuntimeProvenance({ accountId = "", runtime = null, observedAt = new Date().toISOString() } = {}) {
  const client = runtime?.client || null;
  const browser = client?.pupBrowser || null;
  const page = client?.pupPage || null;
  const generation = Number(runtime?.generation || 0) || 0;
  const verified = Boolean(client && browser && page && generation > 0);
  return {
    accountId: clean(accountId),
    ownership: verified ? "verified" : "unavailable",
    source: "local_whatsapp_runtime",
    observedAt: clean(observedAt) || new Date().toISOString(),
    runtimeGeneration: generation || null,
    workerId: opaqueReference(runtime, "wa_worker"),
    browserId: opaqueReference(browser, "wa_browser"),
    pageId: opaqueReference(page, "wa_page"),
  };
}

export function assertWhatsAppRuntimeBrowserOwnership(provenance = {}, {
  accountId = "",
  runtime = null,
  maxAgeMs = 60_000,
  nowMs = Date.now(),
} = {}) {
  const expectedAccountId = clean(accountId);
  const expected = attestWhatsAppRuntimeProvenance({ accountId: expectedAccountId, runtime });
  const observedAtMs = Date.parse(clean(provenance?.observedAt));
  const currentMs = Number(nowMs);
  const ageLimitMs = Math.max(1, Math.min(Number(maxAgeMs) || 60_000, 300_000));
  const fresh = Number.isFinite(observedAtMs) && Number.isFinite(currentMs) &&
    observedAtMs <= currentMs + 5_000 && currentMs - observedAtMs <= ageLimitMs;
  const verified = expected.ownership === "verified" &&
    provenance?.ownership === "verified" &&
    clean(provenance?.accountId) === expectedAccountId &&
    clean(provenance?.source) === clean(expected.source) &&
    Number(provenance?.runtimeGeneration || 0) === Number(expected.runtimeGeneration || 0) &&
    clean(provenance?.workerId) === clean(expected.workerId) &&
    clean(provenance?.browserId) === clean(expected.browserId) &&
    clean(provenance?.pageId) === clean(expected.pageId) &&
    fresh;
  return verified
    ? { ok: true, provenance }
    : {
        ok: false,
        code: "whatsapp_browser_ownership_unverified",
        nextAction: "inspect_authoritative_worker_diagnostics",
      };
}
