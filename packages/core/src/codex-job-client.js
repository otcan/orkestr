// Codex app-server client for Agent Job attempts. It reuses the JSON-RPC
// transport of CodexAppServerClient but never maps Codex threads to Orkestr
// thread records: notifications and server requests go to the job session
// that owns the Codex thread, so job turns never show up in the thread list,
// are never projected into chat messages and are never mirrored to WhatsApp.
// Job clients run in their own app-server process, separate from the one that
// serves chat threads.
import os from "node:os";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { clean, clientKey } from "./codex-app-server-common.js";

const clients = new Map();

export class CodexJobClient extends CodexAppServerClient {
  constructor(options) {
    super(options);
    this.sessions = new Map();
  }

  // listener: { notification(message), serverRequest(message) -> Promise<response | {error}> }
  attach(codexThreadId, listener) {
    const id = clean(codexThreadId);
    this.sessions.set(id, listener);
    return () => {
      if (this.sessions.get(id) === listener) this.sessions.delete(id);
    };
  }

  async handleNotification(message) {
    const params = message.params || {};
    const id = clean(params.threadId || params.thread?.id || params.turn?.threadId);
    await this.sessions.get(id)?.notification?.(message);
  }

  async handleServerRequest(message) {
    const listener = this.sessions.get(clean(message.params?.threadId));
    if (!listener?.serverRequest) {
      this.rejectServerRequest(message.id, "No Orkestr job attempt owns this Codex request.");
      return;
    }
    let response;
    try {
      response = await listener.serverRequest(message);
    } catch (error) {
      response = { error: String(error?.message || error) };
    }
    if (response?.noReply) return;
    if (response?.error) this.rejectServerRequest(message.id, response.error);
    else this.respond(message.id, response?.result ?? {});
  }
}

export async function getCodexJobClient({ env = process.env, home = os.homedir() } = {}) {
  const key = clientKey(env, home);
  const existing = clients.get(key);
  if (existing && !existing.closed) return existing.start();
  const client = new CodexJobClient({ env, home });
  clients.set(key, client);
  try {
    return await client.start();
  } catch (error) {
    clients.delete(key);
    client.close();
    throw error;
  }
}

// Stops every job app-server process (server shutdown; tests simulate a
// process restart with it).
export function stopCodexJobClients() {
  for (const client of clients.values()) client.close();
  clients.clear();
}
