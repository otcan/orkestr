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

export function assertWhatsAppRuntimeBrowserOwnership(provenance = {}, { accountId = "", generation = null } = {}) {
  const expectedAccountId = clean(accountId);
  const expectedGeneration = Number(generation || 0) || 0;
  const verified = provenance?.ownership === "verified" &&
    clean(provenance?.accountId) === expectedAccountId &&
    (!expectedGeneration || Number(provenance?.runtimeGeneration || 0) === expectedGeneration);
  return verified
    ? { ok: true, provenance }
    : {
        ok: false,
        code: "whatsapp_browser_ownership_unverified",
        nextAction: "inspect_authoritative_worker_diagnostics",
      };
}
