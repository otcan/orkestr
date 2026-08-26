import http from "node:http";
import https from "node:https";

function clean(value = "") {
  return String(value || "").trim();
}

function boundedTimeoutMs(value, fallback = 5_000, max = 5_000, min = 10) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function whatsappWorkerConfig(env = process.env) {
  const operationTimeoutMs = boundedTimeoutMs(env.ORKESTR_WA_WORKER_TIMEOUT_MS, 30_000, 120_000, 500);
  const healthTimeoutMs = boundedTimeoutMs(
    env.ORKESTR_WA_WORKER_HEALTH_TIMEOUT_MS || env.ORKESTR_WA_WORKER_TIMEOUT_MS,
    5_000,
    5_000,
  );
  return {
    socketPath: clean(env.ORKESTR_WA_WORKER_SOCKET || "/run/orkestr-wa/sender.sock"),
    baseUrl: clean(env.ORKESTR_WA_WORKER_URL),
    token: clean(env.ORKESTR_WA_WORKER_TOKEN || env.ORKESTR_WA_SERVICE_TOKEN),
    timeoutMs: operationTimeoutMs,
    operationTimeoutMs,
    healthTimeoutMs,
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

function timeoutError() {
  return Object.assign(new Error("whatsapp_worker_timeout"), { statusCode: 503 });
}

function normalizeRequestError(cause) {
  if (cause?.message === "whatsapp_worker_timeout") return cause;
  const error = new Error(cause?.code === "ENOENT" || cause?.code === "ECONNREFUSED" ? "whatsapp_worker_unavailable" : clean(cause?.message) || "whatsapp_worker_request_failed");
  error.statusCode = 503;
  error.cause = cause;
  return error;
}

export function requestWhatsAppWorker(pathname = "/health", { method = "GET", body = null, timeoutMs = null } = {}, env = process.env) {
  const config = whatsappWorkerConfig(env);
  if (!config.baseUrl && !config.socketPath) return Promise.reject(Object.assign(new Error("whatsapp_worker_unconfigured"), { statusCode: 503 }));
  const encoded = body === null || body === undefined ? "" : JSON.stringify(body);
  const request = requestOptions(pathname, method, config, encoded);
  const deadlineMs = boundedTimeoutMs(timeoutMs || config.operationTimeoutMs, config.operationTimeoutMs, 120_000, 10);
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let wallTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (wallTimer) clearTimeout(wallTimer);
      fn(value);
    };
    const req = request.transport.request(request.options, (res) => {
      response = res;
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("error", (cause) => finish(reject, normalizeRequestError(cause)));
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
          error.statusCode = payload?.ok === false && Number(res.statusCode || 0) < 400
            ? 503
            : res.statusCode || 502;
          error.payload = payload;
          error.partialDelivery = payload?.partialDelivery || null;
          if (error.partialDelivery) error.retryable = false;
          finish(reject, error);
          return;
        }
        finish(resolve, payload);
      });
    });
    const abortTimeout = () => {
      const error = timeoutError();
      finish(reject, error);
      req.destroy(error);
      response?.destroy?.(error);
    };
    wallTimer = setTimeout(abortTimeout, deadlineMs);
    wallTimer.unref?.();
    req.setTimeout(deadlineMs, abortTimeout);
    req.once("error", (cause) => {
      finish(reject, normalizeRequestError(cause));
    });
    if (encoded) req.write(encoded);
    req.end();
  });
}

export function whatsappWorkerHealth(env = process.env) {
  const config = whatsappWorkerConfig(env);
  return requestWhatsAppWorker("/health", { timeoutMs: config.healthTimeoutMs }, env);
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
  if (action === "add_participants" || action === "add-participants") {
    return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}/participants`, {
      method: "POST",
      body: {
        participantIds: options.participantIds || [],
        autoSendInviteV4: options.autoSendInviteV4 !== false,
        comment: clean(options.comment),
      },
    }, env);
  }
  if (action === "invite") return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}/invite`, {}, env);
  if (["promote_admins", "demote_admins", "promote-admins", "demote-admins"].includes(action)) {
    const suffix = action === "demote_admins" || action === "demote-admins" ? "/admins/demote" : "/admins";
    return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}${suffix}`, {
      method: "POST",
      body: { participantIds: options.participantIds || [] },
    }, env);
  }
  if (action === "set_picture") {
    return requestWhatsAppWorker(`/accounts/${account}/chats/${conversation}/picture`, {
      method: "POST",
      body: { title: clean(options.title) },
    }, env);
  }
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

export function whatsappWorkerCreateConversation({
  accountId = "",
  name = "",
  participantIds = [],
  adminParticipantIds = [],
  promoteParticipantsAsAdmins = false,
  generatePicture = true,
} = {}, env = process.env) {
  return requestWhatsAppWorker("/chats", {
    method: "POST",
    body: {
      senderAccountId: clean(accountId || "sender"),
      name: clean(name),
      participantIds,
      adminParticipantIds,
      promoteParticipantsAsAdmins,
      generatePicture,
    },
  }, env);
}
