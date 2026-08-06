import { EventEmitter } from "node:events";

const lifecycle = new EventEmitter();
lifecycle.setMaxListeners(50);

export function emitDesktopShareLifecycle(event = {}) {
  lifecycle.emit("change", {
    shareId: String(event.shareId || "").trim(),
    shareGeneration: Math.max(0, Number(event.shareGeneration || 0) || 0),
    lineageId: String(event.lineageId || "").trim(),
    reason: String(event.reason || "desktop_share_changed").trim(),
    at: new Date().toISOString(),
  });
}

export function onDesktopShareLifecycle(listener) {
  lifecycle.on("change", listener);
  return () => lifecycle.off("change", listener);
}
