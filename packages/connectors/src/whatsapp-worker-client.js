import http from "node:http";
import https from "node:https";

function clean(value = "") {
  return String(value || "").trim();
}

export function whatsappWorkerConfig(env = process.env) {
  return {
    socketPath: clean(env.ORKESTR_WA_WORKER_SOCKET || "/run/orkestr-wa/sender.sock"),
    baseUrl: clean(env.ORKESTR_WA_WORKER_URL),
    token: clean(env.ORKESTR_WA_WORKER_TOKEN || env.ORKESTR_WA_SERVICE_TOKEN),
    timeoutMs: Math.max(500, Number(env.ORKESTR_WA_WORKER_TIMEOUT_MS || 30_000) || 30_000),
  };
}

function requestOptions(pathname, method, config, body) {
  const headers = {
    accept: "application/json",
    ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
    ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
  };
  if (config.baseUrl) {
    const url = new URL(pathname, `${config.baseUrl.replace(/\/+$/g, "")}/`);
    return {
      transport: url.protocol === "https:" ? https : http,
      options: { method, hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`, headers },
    };
  }
  return {
    transport: http,
    options: { method, socketPath: config.socketPath, path: pathname, headers },
  };
}

export function requestWhatsAppWorker(pathname = "/health", { method = "GET", body = null } = {}, env = process.env) {
  const config = whatsappWorkerConfig(env);
  if (!config.baseUrl && !config.socketPath) return Promise.reject(Object.assign(new Error("whatsapp_worker_unconfigured"), { statusCode: 503 }));
  const encoded = body === null || body === undefined ? "" : JSON.stringify(body);
  const request = requestOptions(pathname, method, config, encoded);
  return new Promise((resolve, reject) => {
    const req = request.transport.request(request.options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          payload = { ok: false, error: "whatsapp_worker_invalid_json", raw: raw.slice(0, 1000) };
        }
        if ((res.statusCode || 500) >= 400 || payload?.ok === false) {
          const error = new Error(clean(payload?.error) || `whatsapp_worker_http_${res.statusCode || 500}`);
          error.statusCode = res.statusCode || 502;
          error.payload = payload;
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    req.setTimeout(config.timeoutMs, () => req.destroy(Object.assign(new Error("whatsapp_worker_timeout"), { statusCode: 504 })));
    req.once("error", (cause) => {
      const error = new Error(cause?.code === "ENOENT" || cause?.code === "ECONNREFUSED" ? "whatsapp_worker_unavailable" : clean(cause?.message) || "whatsapp_worker_request_failed");
      error.statusCode = 503;
      error.cause = cause;
      reject(error);
    });
    if (encoded) req.write(encoded);
    req.end();
  });
}

export function whatsappWorkerHealth(env = process.env) {
  return requestWhatsAppWorker("/health", {}, env);
}

export function whatsappWorkerAuth(accountId = "", action = "status", env = process.env) {
  const id = encodeURIComponent(clean(accountId || "sender"));
  if (action === "status") return whatsappWorkerHealth(env);
  const endpoint = ["connect", "reconnect"].includes(action) ? "start" : action;
  return requestWhatsAppWorker(`/accounts/${id}/${endpoint}`, { method: "POST", body: {} }, env);
}

export function whatsappWorkerConversations(accountId = "", env = process.env) {
  return requestWhatsAppWorker(`/accounts/${encodeURIComponent(clean(accountId || "sender"))}/chats`, {}, env);
}

export function whatsappWorkerConversation(accountId = "", conversationId = "", action = "history", options = {}, env = process.env) {
  const account = encodeURIComponent(clean(accountId || "sender"));
  const conversation = encodeURIComponent(clean(conversationId));
  if (action === "history") {
    return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}/history?limit=${Math.max(1, Number(options.limit || 30) || 30)}`, {}, env);
  }
  if (action === "participants") return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}/participants`, {}, env);
  if (action === "recover") {
    return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}/recover`, {
      method: "POST",
      body: { limit: options.limit, unreadOnly: options.unreadOnly, markSeen: options.markSeen, eventIds: options.eventIds },
    }, env);
  }
  throw Object.assign(new Error("whatsapp_worker_conversation_action_unsupported"), { statusCode: 400 });
}

export function whatsappWorkerSend({ accountId = "", conversationId = "", text = "", attachmentPaths = [] } = {}, env = process.env) {
  return requestWhatsAppWorker(attachmentPaths.length ? "/send-media" : "/send-text", {
    method: "POST",
    body: {
      accountId: clean(accountId || "sender"),
      to: clean(conversationId),
      text: String(text || ""),
      paths: attachmentPaths,
    },
  }, env);
}

export function whatsappWorkerTyping({ accountId = "", conversationId = "", state = "paused" } = {}, env = process.env) {
  return requestWhatsAppWorker("/typing", {
    method: "POST",
    body: {
      accountId: clean(accountId || "sender"),
      to: clean(conversationId),
      state: clean(state || "paused"),
    },
  }, env);
}

export function whatsappWorkerCreateConversation({ accountId = "", name = "", participantIds = [] } = {}, env = process.env) {
  return requestWhatsAppWorker("/chats", {
    method: "POST",
    body: { senderAccountId: clean(accountId || "sender"), name: clean(name), participantIds },
  }, env);
}
