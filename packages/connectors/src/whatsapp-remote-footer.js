// Only identities reported by the remote message/run describe remote replies.
// Counterpart layers require the same explicit original input and runtime scope.
const layers = new Set(["fast", "deep", "coordinator", "notice"]);
const efforts = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const token = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "";
const known = (value) => token(value) && !["unknown", "unreported"].includes(value.toLowerCase()) ? value : "";

export function remoteLayerMetadata(remote = {}, parent = {}) {
  parent = parent || {};
  const post = parent.timerId === "post" || Boolean(parent.postAuthor);
  // A native question is the Deep run's own post: it keeps its exact-run Deep
  // identity. Any other post without the coordinator author is a plain post.
  const question = parent.postAuthor === "assistant_question" && remote.layer === "deep" && remote.identitySource === "run";
  const layer = parent.postAuthor === "coordinator" ? "coordinator"
    : question ? "deep"
      : post ? "post"
        : remote.firstResponse === true ? "fast"
          : remote.kind === "notice" ? "notice"
            : layers.has(remote.layer) ? remote.layer
              : remote.phase === "final_answer" ? "deep" : "";
  // The Quick run of the input a Deep final answers, as the adapter observed
  // it (V2 #386): a grouped or parallel final names the burst's last
  // input, whose own Quick reply V1 cannot always correlate. `quick: "none"`
  // says no Quick ran for that input (a timer, a probe, Fast off).
  const quick = layer === "deep" || layer === "coordinator" ? {
    ...(remote.quick === "none" ? { remoteQuickState: "none" } : {}),
    ...(known(remote.quickProvider) ? { remoteQuickProvider: remote.quickProvider } : {}),
    ...(known(remote.quickModel) ? { remoteQuickModel: remote.quickModel } : {}),
    ...(efforts.has(remote.quickObservedReasoningEffort) ? { remoteQuickEffort: remote.quickObservedReasoningEffort } : {}),
  } : {};
  return {
    ...(layer ? { remoteLayer: layer } : {}),
    ...(efforts.has(remote.observedReasoningEffort) ? { remoteObservedReasoningEffort: remote.observedReasoningEffort } : {}),
    ...(token(remote.sourceInputId) ? { remoteOriginalInputId: remote.sourceInputId } : {}),
    ...(token(remote.runId) ? { remoteRunId: remote.runId } : {}),
    ...(["run", "post"].includes(remote.identitySource) ? { remoteIdentitySource: remote.identitySource } : {}),
    ...quick,
    // V2 marks a Quick reply that answers one input of a burst, and a grouped
    // Deep final that answers a whole burst (it names the burst's last input);
    // the relay then quotes that input. Only Fast or Deep naming an input qualifies.
    ...((layer === "fast" || layer === "deep") && remote.quoteSource === true && token(remote.sourceInputId) ? { remoteQuoteSource: true } : {}),
    // Older adapters replace a post's identity with the native Deep identity.
    // Only an explicitly preserved post identity can label the coordinator.
    ...(layer === "coordinator" && remote.identitySource !== "post" ? { remoteProvider: null, remoteModel: null } : {}),
  };
}

// Observed facts only. An unknown model or effort is never rendered as
// "unknown" and never filled from settings; a provider whose model was not
// reported reads "codex ?" so the slot keeps its shape.
function identityOf(providerValue, modelValue, effortValue) {
  const provider = known(providerValue);
  const model = known(modelValue);
  const effort = efforts.has(effortValue) ? effortValue : "";
  const modelEffort = model && effort ? `${model}/${effort}` : model || effort;
  if (!provider) return modelEffort;
  return `${provider} ${modelEffort || "?"}`;
}

function identity(message = {}) {
  if (message.remoteLayer === "coordinator" && message.remoteIdentitySource !== "post") return "";
  return identityOf(message.remoteProvider, message.remoteModel, message.remoteObservedReasoningEffort);
}

function counterpart(message, messages, role) {
  if (!Array.isArray(messages) || !token(message.remoteOriginalInputId) || !message.remoteBackend || !message.remoteThreadId) return {};
  const peers = messages.filter((peer) => peer && peer.role === "assistant" && peer.remoteLayer === role &&
    peer.remoteOriginalInputId === message.remoteOriginalInputId && peer.remoteBackend === message.remoteBackend &&
    peer.remoteThreadId === message.remoteThreadId && peer.id !== message.id);
  // Multiple exports may agree; conflicting run identities remain unknown.
  return peers.length && new Set(peers.map(identity)).size === 1 ? peers[0] : {};
}

// The one layer line every model reply carries, in a fixed shape:
//   ⚡ Quick: <provider model | —> · 🧠 Deep: <provider model | pending | —> · ▶ <writer>
// The main slot reads "Coordinator" for a coordinator post. "—" means the
// layer did not run for this input or its identity was not observed; "pending"
// means the Quick reply went out before its Deep final.
export const NOT_OBSERVED = "—";

function quickIdentity(message, messages, layer) {
  if (layer === "fast") return identity(message);
  if (message.remoteQuickState === "none") return "";
  const reported = identityOf(message.remoteQuickProvider, message.remoteQuickModel, message.remoteQuickEffort);
  return reported || identity(counterpart(message, messages, "fast"));
}

export function remoteLayerFooter(message = {}, messages = []) {
  const layer = layers.has(message.remoteLayer) || message.remoteLayer === "post" ? message.remoteLayer : "";
  const coordinator = layer === "coordinator" ? message : counterpart(message, messages, "coordinator");
  const isCoordinator = layer === "coordinator" || coordinator.remoteLayer === "coordinator";
  const main = isCoordinator ? coordinator
    : layer === "deep" || layer === "post" || layer === "" ? message
      : counterpart(message, messages, "deep");
  const quick = quickIdentity(message, messages, layer);
  const mainIdentity = identity(main);
  const writer = { fast: "Quick", deep: "Deep", coordinator: "Coordinator", post: "Post" }[layer] || "Deep";
  const mainText = mainIdentity || (layer === "fast" && !main.remoteLayer ? "pending" : NOT_OBSERVED);
  return `⚡ Quick: ${quick || NOT_OBSERVED} · 🧠 ${isCoordinator ? "Coordinator" : "Deep"}: ${mainText} · ▶ ${writer}`;
}

// The same layer line for a reply produced by V1 itself (no remote runtime):
// V1 has one layer, so Quick reads "—" and the thread's own model fills Deep.
export function localLayerFooter(identityText = "", extras = []) {
  return [`⚡ Quick: ${NOT_OBSERVED}`, `🧠 Deep: ${identityText || NOT_OBSERVED}`, "▶ Deep", ...extras].join(" · ");
}
