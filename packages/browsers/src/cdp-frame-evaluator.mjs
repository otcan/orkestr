/**
 * Evaluate in one direct same-origin child of an already authorized CDP page.
 * The caller owns connection authentication, the desktop lease and form policy.
 * This module neither opens a connection nor grants permission to use one.
 */
export function createSameOriginFrameEvaluator(send, { allowedOrigins, pathPrefix, worldName = "orkestr-managed-frame" }) {
  if (typeof send !== "function" || !Array.isArray(allowedOrigins) || !allowedOrigins.length
      || typeof pathPrefix !== "string" || !pathPrefix.startsWith("/") || !pathPrefix.endsWith("/")
      || typeof worldName !== "string" || !worldName || worldName.length > 100) {
    throw new Error("frame_policy_invalid");
  }
  const origins = new Set(allowedOrigins.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || value !== url.origin || url.username || url.password) throw new Error("frame_policy_invalid");
    return url.origin;
  }));
  let selectedDocument = "", contextId = null;
  const invalidate = () => { selectedDocument = ""; contextId = null; };
  return async (expression) => {
    try {
      const response = await send("Page.getFrameTree");
      const tree = response.result?.frameTree;
      const top = new URL(tree?.frame?.url || "about:blank");
      if (response.error || !origins.has(top.origin) || top.username || top.password
          || !top.pathname.startsWith(pathPrefix)) throw new Error("frame_parent_scope_refused");
      const candidates = (tree.childFrames || []).filter(({ frame }) => {
        try {
          const url = new URL(frame.url);
          return url.origin === top.origin && !url.username && !url.password && url.pathname.startsWith(pathPrefix);
        } catch { return false; }
      });
      if (candidates.length !== 1) throw new Error("frame_missing_or_ambiguous");
      const frame = candidates[0].frame;
      if (!frame.id || !frame.loaderId) throw new Error("frame_document_identity_missing");
      const key = JSON.stringify([frame.id, frame.loaderId, frame.url]);
      if (selectedDocument !== key || contextId === null) {
        const world = await send("Page.createIsolatedWorld", { frameId: frame.id, worldName });
        contextId = world.result?.executionContextId;
        if (world.error || !Number.isInteger(contextId)) throw new Error("frame_context_unavailable");
        selectedDocument = key;
      }
      const result = await send("Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
      if (result.error || result.result?.exceptionDetails || !result.result?.result) throw new Error("frame_evaluation_failed_no_retry");
      return result.result.result.value;
    } catch (error) {
      invalidate();
      throw error;
    }
  };
}
