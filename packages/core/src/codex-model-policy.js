const modelPolicies = Object.freeze({
  standard: Object.freeze([
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-5.6-sol",
  ]),
  demanding: Object.freeze([
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-5.6-sol",
  ]),
  lightweight: Object.freeze([
    "gpt-6-luna",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-sol",
  ]),
});

const fallbackPolicies = Object.freeze({
  standard: Object.freeze(["gpt-5.6-sol"]),
  demanding: Object.freeze(["gpt-6-sol", "gpt-5.6-sol"]),
  lightweight: Object.freeze(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]),
});

function clean(value = "") {
  return String(value || "").trim();
}

function catalogModelId(model = {}) {
  return clean(model.id || model.model || model.slug);
}

export function normalizeCodexModelRole(value = "") {
  const role = clean(value).toLowerCase().replace(/[\s_-]+/g, "");
  if (["demanding", "sre", "release", "releasetrain"].includes(role)) return "demanding";
  if (["light", "lightweight", "worker"].includes(role)) return "lightweight";
  return "standard";
}

export function codexModelCandidates(role = "standard") {
  return [...modelPolicies[normalizeCodexModelRole(role)]];
}

export function defaultCodexModel(role = "standard") {
  const normalized = normalizeCodexModelRole(role);
  if (normalized === "standard") return "gpt-6-sol";
  return modelPolicies[normalized][0];
}

export function codexFallbackModels(role = "standard") {
  return [...fallbackPolicies[normalizeCodexModelRole(role)]];
}

export function resolveCodexModelForCatalog(role = "standard", models = []) {
  const catalog = (Array.isArray(models) ? models : [])
    .map((model) => ({ id: catalogModelId(model), isDefault: model?.isDefault === true }))
    .filter((model) => model.id);
  const available = new Set(catalog.map((model) => model.id.toLowerCase()));
  if (!available.size) return defaultCodexModel(role);
  return codexModelCandidates(role).find((model) => available.has(model.toLowerCase())) ||
    catalog.find((model) => model.isDefault)?.id ||
    catalog[0].id;
}

export function compatibleCodexReasoningEffort(model = "", effort = "") {
  const normalizedModel = clean(model).toLowerCase();
  const normalizedEffort = clean(effort).toLowerCase().replace(/[\s_-]+/g, "");
  if (["gpt-6-astra", "gpt-6.1-sol"].includes(normalizedModel) && ["none", "minimal"].includes(normalizedEffort)) {
    return "low";
  }
  return effort;
}

export function codexModelPolicy() {
  return Object.fromEntries(Object.entries(modelPolicies).map(([role, models]) => [role, [...models]]));
}
