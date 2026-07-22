import { clean, normalizeCodexModel, normalizeCodexServiceTier, normalizeReasoningEffort } from "./codex-app-server-common.js";

function catalogModels(result = {}) {
  return (Array.isArray(result?.data) ? result.data : [])
    .filter((model) => normalizeCodexModel(model?.id || model?.model))
    .map((model) => ({
      ...model,
      id: normalizeCodexModel(model.id || model.model),
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [],
      serviceTiers: Array.isArray(model.serviceTiers) ? model.serviceTiers : [],
    }));
}

function supportedEfforts(model = {}) {
  return model.supportedReasoningEfforts
    .map((option) => normalizeReasoningEffort(option?.reasoningEffort || option))
    .filter(Boolean);
}

function catalogModel(models = [], value = "") {
  const requested = normalizeCodexModel(value).toLowerCase();
  if (!requested) return null;
  return models.find((model) => [model.id, model.model].map((item) => clean(item).toLowerCase()).includes(requested)) || null;
}

function defaultModel(models = []) {
  return models.find((model) => model.isDefault === true) || models[0] || null;
}

function fastTier(model = {}) {
  return model.serviceTiers.find((tier) => {
    const id = clean(tier?.id).toLowerCase();
    const name = clean(tier?.name).toLowerCase();
    return id === "priority" || id === "fast" || name === "fast";
  }) || null;
}

function modelStatusText({ models, model, effort, serviceTier }) {
  const advertisedFastTier = fastTier(model);
  const fastEnabled = Boolean(advertisedFastTier && normalizeCodexServiceTier(advertisedFastTier.id) === normalizeCodexServiceTier(serviceTier));
  const available = models.map((item) => {
    const efforts = supportedEfforts(item);
    const fast = fastTier(item) ? " · fast" : "";
    return `- ${item.id}${efforts.length ? ` (${efforts.join("/")})` : ""}${fast}`;
  });
  return [
    `Model: ${model?.id || "default"}${effort ? ` · effort: ${effort}` : ""}`,
    `Fast: ${fastEnabled ? "on" : "off"}`,
    "Available:",
    ...available,
  ].join("\n");
}

export function codexModelCatalog(result = {}) {
  return catalogModels(result);
}

export function resolveCodexThreadSettingsCommand({ command, text = "", thread = {}, models: inputModels = [] } = {}) {
  const models = catalogModels({ data: inputModels });
  const defaultEntry = defaultModel(models);
  const currentEntry = catalogModel(models, thread.codexModel || thread.executor?.metadata?.codexModel) || defaultEntry;
  const currentEffort = normalizeReasoningEffort(thread.codexReasoningEffort || thread.executor?.metadata?.codexReasoningEffort) ||
    normalizeReasoningEffort(currentEntry?.defaultReasoningEffort);
  const currentTier = normalizeCodexServiceTier(thread.codexServiceTier || thread.executor?.metadata?.codexServiceTier);
  const tokens = clean(text).split(/\s+/).filter(Boolean);

  if (command === "model") {
    if (!tokens.length || tokens[0].toLowerCase() === "status") {
      return { ok: true, action: "status", replyText: modelStatusText({ models, model: currentEntry, effort: currentEffort, serviceTier: currentTier }) };
    }
    if (tokens.length > 2) return { ok: false, error: "Use /model <id> [effort], /model default, or /model." };
    const reset = tokens[0].toLowerCase() === "default";
    const selected = reset ? defaultEntry : catalogModel(models, tokens[0]);
    if (!selected) return { ok: false, error: `Unknown Codex model: ${tokens[0]}. Use /model to list available models.` };
    const supported = supportedEfforts(selected);
    const requestedEffort = tokens[1] ? normalizeReasoningEffort(tokens[1]) : "";
    if (tokens[1] && (!requestedEffort || !supported.includes(requestedEffort))) {
      return { ok: false, error: `Unsupported effort for ${selected.id}. Available: ${supported.join(", ") || "not reported"}.` };
    }
    const effort = requestedEffort || (supported.includes(currentEffort) ? currentEffort : normalizeReasoningEffort(selected.defaultReasoningEffort));
    const selectedFastTier = fastTier(selected);
    const clearUnsupportedTier = Boolean(currentTier && (!selectedFastTier || normalizeCodexServiceTier(selectedFastTier.id) !== currentTier));
    return {
      ok: true,
      action: "update",
      patch: {
        codexModel: reset ? null : selected.id,
        codexReasoningEffort: reset ? null : effort || null,
        ...(clearUnsupportedTier ? { codexServiceTier: null } : {}),
      },
      runtimePatch: { model: selected.id, effort: effort || null, ...(clearUnsupportedTier ? { serviceTier: null } : {}) },
      replyText: `Model set to ${selected.id}${effort ? ` with ${effort} effort` : ""} for this thread.`,
    };
  }

  if (command === "fast") {
    const action = (tokens[0] || "toggle").toLowerCase();
    if (tokens.length > 1 || !["toggle", "on", "off", "status"].includes(action)) {
      return { ok: false, error: "Use /fast, /fast on, /fast off, or /fast status." };
    }
    const tier = fastTier(currentEntry);
    const enabled = Boolean(currentTier && tier && currentTier === normalizeCodexServiceTier(tier.id));
    if (action === "status") return { ok: true, action: "status", replyText: `Fast mode is ${enabled ? "on" : "off"} for this thread.` };
    const enable = action === "on" || (action === "toggle" && !enabled);
    if (enable && !tier) return { ok: false, error: `${currentEntry?.id || "The current model"} does not advertise a fast service tier.` };
    return {
      ok: true,
      action: "update",
      patch: { codexServiceTier: enable ? normalizeCodexServiceTier(tier.id) : null },
      runtimePatch: { serviceTier: enable ? normalizeCodexServiceTier(tier.id) : null },
      replyText: `Fast mode ${enable ? "enabled" : "disabled"} for this thread.`,
    };
  }

  return { ok: false, error: "Unsupported Codex settings command." };
}
