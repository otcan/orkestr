// In-process signal that a thread's messages changed, so the server can push
// a fresh thread summary to open browsers right away instead of on its timer.
import { EventEmitter } from "node:events";

const events = new EventEmitter();
events.setMaxListeners(50);

export function emitThreadMessagesChanged(threadId) {
  if (threadId) events.emit("changed", String(threadId));
}

export function onThreadMessagesChanged(listener) {
  events.on("changed", listener);
  return () => events.off("changed", listener);
}
