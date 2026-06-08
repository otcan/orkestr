function clean(value = "") {
  return String(value || "").trim();
}

function comparableAccountToken(value = "") {
  const text = clean(value).toLowerCase();
  if (!text) return "";
  if (text.startsWith("+")) return text.slice(1);
  return text;
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const comparable = text.toLowerCase();
    if (!text || seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(text);
  }
  return result;
}

function contactTokens(value = "") {
  const text = clean(value);
  if (!text) return new Set();
  const lower = text.toLowerCase();
  const beforeDomain = lower.includes("@") ? lower.split("@")[0] : lower;
  const numeric = beforeDomain.replace(/^\+/, "").replace(/[()\s.-]+/g, "");
  return new Set([lower, comparableAccountToken(lower), beforeDomain, numeric].filter(Boolean));
}

function contactMatches(left = "", right = "") {
  const leftTokens = contactTokens(left);
  const rightTokens = contactTokens(right);
  for (const token of leftTokens) {
    if (rightTokens.has(token)) return true;
  }
  return false;
}

function bindingFromPayload(payload = {}) {
  return payload?.selected || payload?.binding || null;
}

function senderContactsFromBinding(binding = null) {
  if (!binding || typeof binding !== "object") return [];
  return unique([
    ...(Array.isArray(binding.authorizedContactIds) ? binding.authorizedContactIds : []),
    ...(Array.isArray(binding.allowedSenderContactIds) ? binding.allowedSenderContactIds : []),
    ...(Array.isArray(binding.additionalSenderContactIds) ? binding.additionalSenderContactIds : []),
    ...(Array.isArray(binding.acl?.send?.users) ? binding.acl.send.users : []),
    binding.senderContactId,
    binding.senderPhoneNumber,
  ]);
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

export function validateWhatsAppPreflight(options = {}, statusPayload = {}, accountsPayload = {}, bindingPayload = {}) {
  return validateWhatsAppPreflightWithBinding(options, statusPayload, accountsPayload, bindingPayload);
}

export function validateWhatsAppPreflightWithBinding(options = {}, statusPayload = {}, accountsPayload = {}, bindingPayload = {}) {
  const accounts = collectWhatsAppAccounts(statusPayload, accountsPayload);
  const binding = bindingFromPayload(bindingPayload);
  const bindingSenderContacts = senderContactsFromBinding(binding);
  const requestedSenderContact = clean(options.senderContactId);
  if (requestedSenderContact && bindingSenderContacts.length && !bindingSenderContacts.some((contact) => contactMatches(contact, requestedSenderContact))) {
    throw preflightError("sender_contact_not_authorized", {
      senderContactId: requestedSenderContact,
      bindingSenderContacts,
      bindingId: clean(binding?.bindingId || binding?.id),
      threadId: clean(binding?.threadId),
      chatId: clean(binding?.chatId),
    });
  }
  const senderContactIds = requestedSenderContact
    ? unique([requestedSenderContact, ...bindingSenderContacts.filter((contact) => contactMatches(contact, requestedSenderContact))])
    : bindingSenderContacts;
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
      sender: options.manualSend ? null : assertReadyAccount({ accounts, accountId: options.senderAccountId, role: "sender" }),
      senderContactIds: options.manualSend ? senderContactIds : [],
    },
    observed: {
      sender,
      senderContactIds,
      binding: binding
        ? {
          bindingId: clean(binding.bindingId || binding.id),
          threadId: clean(binding.threadId),
          chatId: clean(binding.chatId),
          displayName: clean(binding.displayName || binding.threadName),
          responderAccountId: clean(binding.responderAccountId || binding.replyAccountId || binding.bridgeAccountId),
          runtimeAccountId: clean(binding.runtimeAccountId),
        }
        : null,
    },
  };
}
