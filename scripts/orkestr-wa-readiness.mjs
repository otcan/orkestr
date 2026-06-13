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

export function evaluateWaServiceReadiness(payload = {}, requiredAccounts = []) {
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const missing = [];
  const notReady = [];

  for (const required of requiredAccounts) {
    const wanted = clean(required).toLowerCase();
    const account = accounts.find((candidate) => accountNames(candidate).includes(wanted));
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

  return {
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
  return evaluateWaServiceReadiness(payload, options.accounts || []);
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
