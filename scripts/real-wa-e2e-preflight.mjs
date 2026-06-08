function clean(value = "") {
  return String(value || "").trim();
}

function comparableAccountToken(value = "") {
  const text = clean(value).toLowerCase();
  if (!text) return "";
  if (text.startsWith("+")) return text.slice(1);
  return text;
}

function accountTokens(account = {}) {
  const values = [
    account.accountId,
    account.id,
    account.runtimeAccountId,
    account.role,
    account.alias,
    account.phoneNumber,
    account.contactId,
    account.jid,
    account.ownerContactId,
  ];
  const result = new Set();
  for (const value of values) {
    const text = clean(value);
    if (!text) continue;
    result.add(text.toLowerCase());
    result.add(comparableAccountToken(text));
    if (text.includes("@")) result.add(comparableAccountToken(text.split("@")[0]));
  }
  return result;
}

function accountMatches(account = {}, requested = "") {
  const wanted = comparableAccountToken(requested);
  if (!wanted) return false;
  return accountTokens(account).has(wanted);
}

function accountReady(account = {}) {
  return account?.ready === true || clean(account?.state).toLowerCase() === "ready";
}

function summarizeAccount(account = {}) {
  return {
    accountId: clean(account.accountId || account.id),
    runtimeAccountId: clean(account.runtimeAccountId),
    displayName: clean(account.displayName || account.name || account.label),
    ready: accountReady(account),
    state: clean(account.state),
    paired: account.paired === true,
    authenticated: account.authenticated === true,
    started: account.started === true,
    phoneNumber: clean(account.phoneNumber),
    contactId: clean(account.contactId || account.jid),
    nextAction: clean(account.nextAction),
  };
}

function dedupeAccounts(accounts = []) {
  const seen = new Set();
  const result = [];
  for (const account of accounts) {
    const summary = summarizeAccount(account);
    const key = [
      summary.accountId,
      summary.runtimeAccountId,
      summary.phoneNumber,
      summary.contactId,
      summary.state,
      summary.ready ? "ready" : "not-ready",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(summary);
  }
  return result;
}

function collectWhatsAppAccounts(statusPayload = {}, accountsPayload = {}) {
  return dedupeAccounts([
    ...(Array.isArray(statusPayload.accounts) ? statusPayload.accounts : []),
    ...(Array.isArray(statusPayload.health?.accounts) ? statusPayload.health.accounts : []),
    ...(Array.isArray(accountsPayload.accounts) ? accountsPayload.accounts : []),
    ...(Array.isArray(accountsPayload.status?.accounts) ? accountsPayload.status.accounts : []),
    ...(Array.isArray(accountsPayload.status?.health?.accounts) ? accountsPayload.status.health.accounts : []),
  ]);
}

function findAccount(accounts = [], accountId = "") {
  return accounts.find((account) => accountMatches(account, accountId)) || null;
}

function preflightError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function assertReadyAccount({ accounts = [], accountId = "", role = "" } = {}) {
  const account = findAccount(accounts, accountId);
  if (!account) {
    throw preflightError(`${role}_account_not_found`, { role, accountId, accounts });
  }
  if (!account.ready) {
    throw preflightError(`${role}_account_not_ready`, { role, accountId, account, accounts });
  }
  return account;
}

export function validateWhatsAppPreflight(options = {}, statusPayload = {}, accountsPayload = {}) {
  const accounts = collectWhatsAppAccounts(statusPayload, accountsPayload);
  const responder = assertReadyAccount({
    accounts,
    accountId: options.responderAccountId,
    role: "responder",
  });
  const sender = clean(options.senderAccountId)
    ? findAccount(accounts, options.senderAccountId)
    : null;
  if (!options.manualSend) {
    if (!sender) throw preflightError("sender_account_not_found", { role: "sender", accountId: options.senderAccountId, accounts });
    if (!sender.ready) throw preflightError("sender_account_not_ready", { role: "sender", accountId: options.senderAccountId, account: sender, accounts });
  }
  return {
    mode: clean(statusPayload.mode),
    state: clean(statusPayload.state),
    manualSend: options.manualSend === true,
    accounts,
    required: {
      responder,
      sender: options.manualSend ? sender : assertReadyAccount({ accounts, accountId: options.senderAccountId, role: "sender" }),
    },
  };
}
