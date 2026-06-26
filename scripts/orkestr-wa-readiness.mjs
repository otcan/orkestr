#!/usr/bin/env node

function clean(value = "") {
  return String(value || "").trim();
}

function splitList(value = "") {
  return clean(value)
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function truthy(value = "") {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    bridgeUrl: clean(env.ORKESTR_WA_SERVICE_URL || env.WHATSAPP_BRIDGE_URL || "http://127.0.0.1:18914"),
    token: clean(
      env.ORKESTR_WA_SERVICE_TOKEN ||
      env.WHATSAPP_BRIDGE_TOKEN ||
      env.WA_HTTP_TOKEN ||
      env.ORKESTR_WHATSAPP_BRIDGE_TOKEN,
    ),
    accounts: splitList(env.ORKESTR_WA_REQUIRED_ACCOUNTS || env.ORKESTR_REQUIRED_WHATSAPP_ACCOUNTS || ""),
    requireRoutingPolicy: truthy(env.ORKESTR_WA_REQUIRE_ROUTING_POLICY),
    requireAccessPolicy: truthy(env.ORKESTR_WA_REQUIRE_ACCESS_POLICY),
    accessPolicyClient: clean(env.ORKESTR_WA_ACCESS_POLICY_CLIENT_ID || env.ORKESTR_WA_SERVICE_CLIENT_ID || env.ORKESTR_WHATSAPP_BRIDGE_CLIENT_ID || env.WHATSAPP_BRIDGE_CLIENT_ID),
    inboundAccount: clean(env.ORKESTR_WA_INBOUND_ACCOUNT_ID || env.ORKESTR_WHATSAPP_INBOUND_ACCOUNT_ID || env.ORKESTR_WHATSAPP_SENDER_ACCOUNT_ID || env.ORKESTR_WHATSAPP_SENDER_ROLE || "sender"),
    outboundAccount: clean(env.ORKESTR_WA_OUTBOUND_ACCOUNT_ID || env.ORKESTR_WHATSAPP_RESPONDER_ACCOUNT_ID || env.ORKESTR_WHATSAPP_RESPONDER_ROLE || "responder"),
    timeoutMs: Number(env.ORKESTR_WA_READINESS_TIMEOUT_MS || env.WHATSAPP_BRIDGE_STATUS_TIMEOUT_MS || 5000) || 5000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--bridge-url" || arg === "--url") {
      options.bridgeUrl = clean(argv[++index]);
    } else if (arg === "--token") {
      options.token = clean(argv[++index]);
    } else if (arg === "--account") {
      const account = clean(argv[++index]);
      if (account) options.accounts.push(account);
    } else if (arg === "--accounts") {
      options.accounts.push(...splitList(argv[++index]));
    } else if (arg === "--require-routing-policy") {
      options.requireRoutingPolicy = true;
    } else if (arg === "--require-access-policy") {
      options.requireAccessPolicy = true;
    } else if (arg === "--access-policy-client" || arg === "--client-id" || arg === "--instance-id") {
      options.accessPolicyClient = clean(argv[++index]);
    } else if (arg === "--inbound-account" || arg === "--sender-account") {
      options.inboundAccount = clean(argv[++index]);
    } else if (arg === "--outbound-account" || arg === "--responder-account") {
      options.outboundAccount = clean(argv[++index]);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]) || options.timeoutMs;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }

  options.accounts = [...new Set(options.accounts)];
  return options;
}

function usage() {
  return `Usage: node scripts/orkestr-wa-readiness.mjs --bridge-url http://127.0.0.1:18914 --account sender --account responder

Checks a standalone orkestr-wa service. Account matching accepts accountId, id,
label, runtimeAccountId, and legacyRoleAliases.

Add --require-routing-policy to assert the service advertises the Orkestr
sender/responder policy: sender queues inbound work, responder is tools/outbound
only.

Add --require-access-policy to assert the service has an enforced client
allowlist. Use --client-id to require a specific Orkestr instance/client entry.
`;
}

function serviceUrl(bridgeUrl = "") {
  const base = clean(bridgeUrl).replace(/\/+$/, "");
  if (!base) throw new Error("wa_bridge_url_required");
  return new URL(`${base}/health`);
}

function accountNames(account = {}) {
  return [
    account.accountId,
    account.id,
    account.label,
    account.runtimeAccountId,
    account.phoneNumber,
    account.contactId,
    ...(Array.isArray(account.aliases) ? account.aliases : []),
    ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : []),
  ].map((value) => clean(value).toLowerCase()).filter(Boolean);
}

function accountReady(account = {}) {
  return account.ready === true ||
    account.authenticated === true ||
    account.clientReady === true ||
    clean(account.state).toLowerCase() === "ready" ||
    clean(account.status).toLowerCase() === "ready";
}

function accountMatches(accounts = [], required = "") {
  const wanted = clean(required).toLowerCase();
  if (!wanted) return null;
  return accounts.find((candidate) => accountNames(candidate).includes(wanted)) || null;
}

function accountAllowedNames(account = null, fallback = "") {
  return new Set([
    ...accountNames(account || {}),
    clean(fallback).toLowerCase(),
  ].filter(Boolean));
}

function policyAccountMatches(policyValue = "", account = null, fallback = "") {
  const value = clean(policyValue).toLowerCase();
  if (!value) return false;
  return accountAllowedNames(account, fallback).has(value);
}

function evaluateRoutingPolicy(payload = {}, accounts = [], options = {}) {
  if (!options.requireRoutingPolicy) return { required: false, ok: true };
  const policy = payload.routingPolicy && typeof payload.routingPolicy === "object" ? payload.routingPolicy : {};
  const inboundAccount = clean(options.inboundAccount || "sender");
  const outboundAccount = clean(options.outboundAccount || "responder");
  const errors = [];
  const inbound = accountMatches(accounts, inboundAccount);
  const outbound = accountMatches(accounts, outboundAccount);
  if (!policy.name) errors.push("routing_policy_missing");
  if (!inbound) errors.push(`inbound_account_missing:${inboundAccount}`);
  if (!outbound) errors.push(`outbound_account_missing:${outboundAccount}`);
  if (!policyAccountMatches(policy.inboundQueueAccountId, inbound, inboundAccount)) {
    errors.push(`inbound_queue_account_mismatch:${clean(policy.inboundQueueAccountId) || "missing"}`);
  }
  if (!policyAccountMatches(policy.outboundAccountId, outbound, outboundAccount)) {
    errors.push(`outbound_account_mismatch:${clean(policy.outboundAccountId) || "missing"}`);
  }
  if (!policyAccountMatches(policy.toolAccountId, outbound, outboundAccount)) {
    errors.push(`tool_account_mismatch:${clean(policy.toolAccountId) || "missing"}`);
  }
  if (!policyAccountMatches(policy.injectedInboundAccountId, outbound, outboundAccount)) {
    errors.push(`injected_inbound_account_mismatch:${clean(policy.injectedInboundAccountId) || "missing"}`);
  }
  if (!policyAccountMatches(policy.injectedRouteAccountId, inbound, inboundAccount)) {
    errors.push(`injected_route_account_mismatch:${clean(policy.injectedRouteAccountId) || "missing"}`);
  }
  if (policy.responderQueuesInbound !== false) errors.push("responder_must_not_queue_inbound");
  return {
    required: true,
    ok: errors.length === 0,
    inboundAccount,
    outboundAccount,
    policy: {
      name: clean(policy.name),
      inboundQueueAccountId: clean(policy.inboundQueueAccountId),
      outboundAccountId: clean(policy.outboundAccountId),
      toolAccountId: clean(policy.toolAccountId),
      injectedInboundAccountId: clean(policy.injectedInboundAccountId),
      injectedRouteAccountId: clean(policy.injectedRouteAccountId),
      responderQueuesInbound: policy.responderQueuesInbound === false ? false : Boolean(policy.responderQueuesInbound),
    },
    errors,
  };
}

function evaluateAccessPolicy(payload = {}, options = {}) {
  if (!options.requireAccessPolicy) return { required: false, ok: true };
  const policy = payload.accessPolicy && typeof payload.accessPolicy === "object" ? payload.accessPolicy : {};
  const clientId = clean(options.accessPolicyClient);
  const clients = policy.clients && typeof policy.clients === "object" && !Array.isArray(policy.clients)
    ? policy.clients
    : {};
  const errors = [];
  if (policy.enforced !== true) errors.push("access_policy_not_enforced");
  if (clientId && !clients[clientId]) errors.push(`access_policy_client_missing:${clientId}`);
  return {
    required: true,
    ok: errors.length === 0,
    enforced: policy.enforced === true,
    clientId,
    clientCount: Object.keys(clients).length,
    errors,
  };
}

export function evaluateWaServiceReadiness(payload = {}, requiredAccounts = [], options = {}) {
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const missing = [];
  const notReady = [];

  for (const required of requiredAccounts) {
    const account = accountMatches(accounts, required);
    if (!account) {
      missing.push(required);
    } else if (!accountReady(account)) {
      notReady.push({
        account: required,
        state: clean(account.state || account.status || "unknown"),
        qrAvailable: account.qrAvailable === true,
        error: clean(account.error),
      });
    }
  }

  const result = {
    ok: payload.ok === true && missing.length === 0 && notReady.length === 0,
    serviceReady: payload.ready === true || clean(payload.state).toLowerCase() === "ready",
    requiredAccounts,
    missing,
    notReady,
    accounts: accounts.map((account) => ({
      accountId: clean(account.accountId || account.id),
      label: clean(account.label),
      runtimeAccountId: clean(account.runtimeAccountId),
      state: clean(account.state || account.status),
      ready: accountReady(account),
      qrAvailable: account.qrAvailable === true,
      updatedAt: clean(account.updatedAt),
    })),
    routingPolicy: evaluateRoutingPolicy(payload, accounts, options),
    accessPolicy: evaluateAccessPolicy(payload, options),
  };
  return {
    ...result,
    ok: result.ok && result.routingPolicy.ok && result.accessPolicy.ok,
  };
}

export async function checkWaServiceReadiness(options = {}, fetchImpl = fetch) {
  const url = serviceUrl(options.bridgeUrl);
  const headers = options.token ? { authorization: `Bearer ${options.token}` } : {};
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(Math.max(1, Number(options.timeoutMs || 5000) || 5000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    return {
      ok: false,
      status: response.status,
      error: clean(payload.error || `wa_service_health_failed_${response.status}`),
    };
  }
  return evaluateWaServiceReadiness(payload, options.accounts || [], options);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await checkWaServiceReadiness(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  });
}
