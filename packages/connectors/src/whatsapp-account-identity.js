function clean(value = "") {
  return String(value || "").trim();
}

function splitList(value = "") {
  return clean(value)
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function whatsappLegacyRoleNames(env = process.env) {
  return new Set([
    clean(env.ORKESTR_WHATSAPP_SENDER_ROLE || env.WHATSAPP_SENDER_ROLE || "sender"),
    clean(env.ORKESTR_WHATSAPP_RESPONDER_ROLE || env.WHATSAPP_RESPONDER_ROLE || "responder"),
    ...splitList(env.ORKESTR_WHATSAPP_LEGACY_ACCOUNT_IDS || env.WHATSAPP_LEGACY_ACCOUNT_IDS),
  ].filter(Boolean).map((item) => item.toLowerCase()));
}

export function whatsappPlaceholderAccountIds(env = process.env) {
  return new Set([
    "account-1",
    "account-2",
    ...whatsappLegacyRoleNames(env),
  ].map((item) => item.toLowerCase()));
}

export function isWhatsAppPlaceholderAccountId(value = "", env = process.env) {
  return whatsappPlaceholderAccountIds(env).has(clean(value).toLowerCase());
}

export function whatsappNumericIdentity(value = "") {
  const text = clean(value);
  if (!text) return "";
  const withoutPrefix = text.replace(/^whatsapp:/i, "");
  const beforeDomain = withoutPrefix.replace(/@(c\.us|s\.whatsapp\.net|lid)$/i, "");
  const compact = beforeDomain.replace(/[()\s.-]+/g, "");
  const match = compact.match(/^\+?([0-9]{5,})$/);
  return match ? match[1] : "";
}

export function whatsappAccountPhoneIdentity(account = {}) {
  return whatsappNumericIdentity(
    account.phoneNumber ||
    account.contactId ||
    account.wid ||
    account.id?._serialized ||
    account.me?._serialized ||
    account.info?.wid?._serialized ||
    "",
  );
}

export function canonicalWhatsAppAccountId(account = {}, env = process.env) {
  const rawId = clean(account.accountId || account.id);
  const phoneIdentity = whatsappAccountPhoneIdentity(account);
  if (phoneIdentity && (!rawId || isWhatsAppPlaceholderAccountId(rawId, env))) return phoneIdentity;
  return rawId || phoneIdentity;
}

export function whatsappAccountLookupKeys(account = {}, env = process.env) {
  const keys = [
    clean(account.accountId),
    clean(account.id),
    clean(account.runtimeAccountId),
    clean(account.relayTargetAccountId),
    clean(account.contactId),
    clean(account.phoneNumber),
    whatsappNumericIdentity(account.accountId),
    whatsappNumericIdentity(account.id),
    whatsappNumericIdentity(account.runtimeAccountId),
    whatsappNumericIdentity(account.contactId),
    whatsappNumericIdentity(account.phoneNumber),
    whatsappAccountPhoneIdentity(account),
    ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : []),
  ];
  const seen = new Set();
  const result = [];
  for (const value of keys) {
    const key = clean(value);
    const comparable = key.toLowerCase();
    if (!key || seen.has(comparable)) continue;
    seen.add(comparable);
    result.push(key);
  }
  return result;
}

export function findWhatsAppAccountByAnyId(accounts = [], accountId = "", env = process.env) {
  const wanted = clean(accountId).toLowerCase();
  if (!wanted) return null;
  const wantedNumeric = whatsappNumericIdentity(wanted);
  return (Array.isArray(accounts) ? accounts : []).find((account) => {
    const keys = whatsappAccountLookupKeys(account, env);
    return keys.some((key) => {
      const comparable = key.toLowerCase();
      return comparable === wanted || (wantedNumeric && whatsappNumericIdentity(key) === wantedNumeric);
    });
  }) || null;
}
