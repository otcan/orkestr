function clean(value = "") {
  return String(value || "").trim();
}

function splitList(value = "") {
  return clean(value)
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(value = "") {
  const raw = clean(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const error = new Error("invalid_wa_service_policy_json");
    error.statusCode = 503;
    throw error;
  }
}

function arrayPolicy(value, fallback = []) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  if (typeof value === "string") return splitList(value);
  return fallback;
}

export function waServiceAccessPolicy(env = process.env) {
  const explicit = parseJsonObject(env.ORKESTR_WA_SERVICE_POLICY_JSON || env.ORKESTR_WHATSAPP_SERVICE_POLICY_JSON);
  const clientsRaw = explicit.clients && typeof explicit.clients === "object" && !Array.isArray(explicit.clients)
    ? explicit.clients
    : {};
  const clients = {};
  for (const [clientId, clientRaw] of Object.entries(clientsRaw)) {
    if (!clientRaw || typeof clientRaw !== "object" || Array.isArray(clientRaw)) continue;
    const recipients = arrayPolicy(clientRaw.recipients);
    clients[clean(clientId)] = {
      accounts: arrayPolicy(clientRaw.accounts),
      recipients,
      sendRecipients: arrayPolicy(clientRaw.sendRecipients, recipients),
      historyRecipients: arrayPolicy(clientRaw.historyRecipients, recipients),
      createChatParticipants: arrayPolicy(clientRaw.createChatParticipants, recipients),
      pairing: clientRaw.pairing === true,
      manageAccounts: clientRaw.manageAccounts === true,
      label: clean(clientRaw.label),
    };
  }
  const defaultAccounts = arrayPolicy(env.ORKESTR_WA_SERVICE_ALLOWED_ACCOUNTS || env.ORKESTR_WHATSAPP_SERVICE_ALLOWED_ACCOUNTS);
  const defaultRecipients = arrayPolicy(env.ORKESTR_WA_SERVICE_ALLOWED_RECIPIENTS || env.ORKESTR_WHATSAPP_SERVICE_ALLOWED_RECIPIENTS);
  if (!Object.keys(clients).length && (defaultAccounts.length || defaultRecipients.length)) {
    clients.default = {
      accounts: defaultAccounts,
      recipients: defaultRecipients,
      sendRecipients: defaultRecipients,
      historyRecipients: defaultRecipients,
      createChatParticipants: defaultRecipients,
      pairing: false,
      manageAccounts: false,
      label: "default",
    };
  }
  return {
    enforced: Object.keys(clients).length > 0,
    clients,
  };
}

export function publicAccessPolicy(env = process.env) {
  const policy = waServiceAccessPolicy(env);
  return {
    enforced: policy.enforced,
    clients: Object.fromEntries(Object.entries(policy.clients).map(([clientId, client]) => [clientId, {
      accounts: client.accounts,
      recipients: client.recipients,
      sendRecipients: client.sendRecipients,
      historyRecipients: client.historyRecipients,
      createChatParticipants: client.createChatParticipants,
      pairing: client.pairing,
      manageAccounts: client.manageAccounts,
      label: client.label,
    }])),
  };
}

function requestClientId(req, url, body = {}) {
  return clean(
    req.headers["x-orkestr-instance-id"] ||
    req.headers["x-orkestr-client-id"] ||
    url.searchParams.get("clientId") ||
    body.clientId ||
    "default",
  );
}

function policyValueMatches(allowed = [], actual = "") {
  const value = clean(actual).toLowerCase();
  if (!value) return false;
  const digits = value.replace(/\D+/g, "");
  return allowed.some((candidate) => {
    const allowedValue = clean(candidate).toLowerCase();
    if (!allowedValue) return false;
    if (allowedValue === "*") return true;
    if (allowedValue === value) return true;
    if (allowedValue.startsWith("*.") && value.endsWith(allowedValue.slice(1))) return true;
    const allowedDigits = allowedValue.replace(/\D+/g, "");
    return Boolean(allowedDigits && digits && allowedDigits === digits);
  });
}

function denyPolicy(clientId, reason, detail = {}) {
  const error = new Error(`wa_service_policy_denied:${reason}`);
  error.statusCode = 403;
  error.auditEvent = {
    type: "wa_service_policy_denied",
    clientId,
    reason,
    ...detail,
  };
  throw error;
}

export function requireWaServicePolicy(req, url, env, body = {}, checks = {}) {
  const policy = waServiceAccessPolicy(env);
  if (!policy.enforced) return { clientId: requestClientId(req, url, body), enforced: false };
  const clientId = requestClientId(req, url, body);
  const client = policy.clients[clientId];
  if (!client) denyPolicy(clientId, "unknown_client");
  for (const accountId of checks.accounts || []) {
    if (!policyValueMatches(client.accounts, accountId)) {
      denyPolicy(clientId, "account_not_allowed", { accountId: clean(accountId) });
    }
  }
  const recipientLists = {
    send: client.sendRecipients,
    history: client.historyRecipients,
    createChat: client.createChatParticipants,
  };
  for (const recipient of checks.recipients || []) {
    const allowed = recipientLists[checks.recipientScope || "history"] || client.recipients;
    if (!policyValueMatches(allowed, recipient)) {
      denyPolicy(clientId, "recipient_not_allowed", {
        recipient: clean(recipient),
        scope: checks.recipientScope || "history",
      });
    }
  }
  if (checks.pairing === true && client.pairing !== true) denyPolicy(clientId, "pairing_not_allowed");
  if (checks.manageAccounts === true && client.manageAccounts !== true) {
    denyPolicy(clientId, "account_management_not_allowed");
  }
  return { clientId, enforced: true };
}
