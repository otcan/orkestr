// Only identities reported by the remote message/run describe remote replies.
// Counterpart layers require the same explicit original input and runtime scope.
const layers = new Set(["fast", "deep", "coordinator", "notice"]);
const efforts = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const token = (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "";
const known = (value) => token(value) && !["unknown", "unreported"].includes(value.toLowerCase()) ? value : "";

export function remoteLayerMetadata(remote = {}, parent = {}) {
  parent = parent || {};
  const post = parent.timerId === "post" || Boolean(parent.postAuthor);
  const layer = parent.postAuthor === "coordinator" ? "coordinator"
    : post ? ""
      : remote.firstResponse === true ? "fast"
        : remote.kind === "notice" ? "notice"
          : layers.has(remote.layer) ? remote.layer
            : remote.phase === "final_answer" ? "deep" : "";
  return {
    ...(layer ? { remoteLayer: layer } : {}),
    ...(efforts.has(remote.observedReasoningEffort) ? { remoteObservedReasoningEffort: remote.observedReasoningEffort } : {}),
    ...(token(remote.sourceInputId) ? { remoteOriginalInputId: remote.sourceInputId } : {}),
    ...(token(remote.runId) ? { remoteRunId: remote.runId } : {}),
    ...(["run", "post"].includes(remote.identitySource) ? { remoteIdentitySource: remote.identitySource } : {}),
    // Older adapters replace a post's identity with the native Deep identity.
    // Only an explicitly preserved post identity can label the coordinator.
    ...(layer === "coordinator" && remote.identitySource !== "post" ? { remoteProvider: null, remoteModel: null } : {}),
  };
}

// Observed facts only. An unknown provider, model or effort is omitted, never
// rendered as "unknown"; a layer with no observed fact yields "".
function identity(message = {}) {
  if (message.remoteLayer === "coordinator" && message.remoteIdentitySource !== "post") return "";
  const provider = known(message.remoteProvider);
  const model = known(message.remoteModel);
  const effort = efforts.has(message.remoteObservedReasoningEffort) ? message.remoteObservedReasoningEffort : "";
  const modelEffort = model && effort ? `${model}/${effort}` : model || effort;
  return [provider, modelEffort].filter(Boolean).join(" ");
}

function counterpart(message, messages, role) {
  if (!token(message.remoteOriginalInputId) || !message.remoteBackend || !message.remoteThreadId) return {};
  const peers = messages.filter((peer) => peer.role === "assistant" && peer.remoteLayer === role &&
    peer.remoteOriginalInputId === message.remoteOriginalInputId && peer.remoteBackend === message.remoteBackend &&
    peer.remoteThreadId === message.remoteThreadId && peer.id !== message.id);
  // Multiple exports may agree; conflicting run identities remain unknown.
  return peers.length && new Set(peers.map(identity)).size === 1 ? peers[0] : {};
}

// One compact line; "" when neither layer has an observed identity.
export function remoteLayerFooter(message = {}, messages = []) {
  const layer = layers.has(message.remoteLayer) ? message.remoteLayer : "";
  const quick = layer === "fast" ? message : counterpart(message, messages, "fast");
  const coordinator = layer === "coordinator" ? message : counterpart(message, messages, "coordinator");
  const isCoordinator = layer === "coordinator" || coordinator.remoteLayer === "coordinator";
  const main = isCoordinator ? coordinator : layer === "deep" ? message : counterpart(message, messages, "deep");
  const quickIdentity = identity(quick);
  const mainIdentity = identity(main);
  if (!quickIdentity && !mainIdentity) return "";
  const writer = { fast: "Quick", deep: "Deep", coordinator: "Coordinator", notice: "Notice" }[layer];
  return [
    quickIdentity ? `⚡ Quick: ${quickIdentity}` : "",
    mainIdentity ? `🧠 ${isCoordinator ? "Coordinator" : "Deep"}: ${mainIdentity}`
      : layer === "fast" && !main.remoteLayer ? "🧠 Deep: pending" : "",
    writer ? `▶ ${writer}` : "",
  ].filter(Boolean).join(" · ");
}
