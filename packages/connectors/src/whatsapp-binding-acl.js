function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = pickString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function listValues(...values) {
  return unique(values.flatMap((value) => Array.isArray(value) ? value : [value]));
}

function whatsappIdentityCandidates(value = "") {
  const text = pickString(value).toLowerCase();
  if (!text) return [];
  const values = [text];
  const digits = text.replace(/[^\d]/g, "");
  if (digits) {
    values.push(digits, `+${digits}`, `${digits}@c.us`);
  }
  const contactMatch = text.match(/^(\d+)@(c\.us|lid)$/i);
  if (contactMatch?.[1]) {
    values.push(contactMatch[1], `+${contactMatch[1]}`, `${contactMatch[1]}@${contactMatch[2].toLowerCase()}`);
  }
  return unique(values);
}

function sameWhatsAppIdentity(left = "", right = "") {
  const leftValues = new Set(whatsappIdentityCandidates(left));
  return whatsappIdentityCandidates(right).some((value) => leftValues.has(value));
}

function contextAllowedRecipientValues(context = {}) {
  return listValues(
    context.chatId,
    context.allowedChatIds,
    context.allowedChats,
    context.allowedRecipients,
    context.allowedRecipientIds,
    context.allowedPhoneNumbers,
    context.whatsappNumbers,
    context.phoneNumbers,
  );
}

function contextHasRecipientScope(context = {}) {
  return contextAllowedRecipientValues(context).length > 0;
}

function recipientScopeMatchesSelector(selectorChatId = "", context = {}) {
  const allowed = contextAllowedRecipientValues(context);
  if (!allowed.length) return true;
  const chatId = pickString(selectorChatId);
  if (!chatId) return true;
  return allowed.some((value) => sameWhatsAppIdentity(value, chatId));
}

export function bindingAcl(binding = {}) {
  const existingAcl = binding.acl && typeof binding.acl === "object" && !Array.isArray(binding.acl)
    ? binding.acl
    : {};
  const sendAcl = existingAcl.send && typeof existingAcl.send === "object" && !Array.isArray(existingAcl.send)
    ? existingAcl.send
    : binding.sendAcl && typeof binding.sendAcl === "object" && !Array.isArray(binding.sendAcl)
    ? binding.sendAcl
    : null;
  const additional = Array.isArray(binding.additionalParticipantIds) ? binding.additionalParticipantIds.filter(Boolean) : [];
  const sendMode = sendAcl?.mode ||
    (binding.allowOtherPeople === true || binding.allowOtherPeopleConfirmed === true
      ? "all-users"
      : additional.length && binding.additionalParticipantsEnabled === true
        ? "users"
        : "owner-only");
  const aclFor = (action, fallback) => {
    const value = existingAcl[action] && typeof existingAcl[action] === "object" && !Array.isArray(existingAcl[action])
      ? existingAcl[action]
      : {};
    return {
      mode: pickString(value.mode, fallback),
      users: Array.isArray(value.users) ? unique(value.users) : [],
    };
  };
  return {
    send: {
      mode: sendMode,
      users: sendMode === "users" ? unique([...(Array.isArray(sendAcl?.users) ? sendAcl.users : []), ...additional]) : [],
    },
    read: aclFor("read", "owner-only"),
    receive: aclFor("receive", "thread"),
    manage: aclFor("manage", "owner-only"),
  };
}

function contextValues(context = {}) {
  return listValues(
    context.principalId,
    context.ownerUserId,
    context.userId,
    context.instanceId,
    context.accountId,
    context.bindingId,
    context.threadId,
    context.chatId,
  ).map((value) => value.toLowerCase());
}

function sameContextValue(left = "", right = "") {
  return Boolean(pickString(left) && pickString(right) && pickString(left).toLowerCase() === pickString(right).toLowerCase());
}

function contextHasScopedSelector(context = {}) {
  return Boolean(
    context &&
    Object.keys(context).length > 0 &&
    context.legacy !== true &&
    (pickString(context.accountId) || pickString(context.chatId) || pickString(context.bindingId) || contextHasRecipientScope(context)),
  );
}

function bindingSelectorValues(binding = {}) {
  return {
    bindingId: pickString(binding.bindingId, binding.id),
    chatId: pickString(binding.chatId),
    accountIds: listValues(
      binding.accountId,
      binding.responderAccountId,
      binding.responderConnectorAccountId,
      binding.outboundAccountId,
      binding.targetAccountId,
      ...(Array.isArray(binding.accountIds) ? binding.accountIds : []),
    ),
  };
}

export function whatsappBridgeTokenContextMatchesSelector(selector = {}, context = {}, binding = null, options = {}) {
  if (!contextHasScopedSelector(context)) return true;
  const selected = bindingSelectorValues(binding || {});
  const selectorAccountId = pickString(selector.accountId, selector.account);
  const selectorChatId = pickString(selector.chatId, selector.to);
  const selectorBindingId = pickString(selector.bindingId, selector.id);
  const accountIds = listValues(selectorAccountId, ...selected.accountIds);
  const chatId = pickString(selectorChatId, selected.chatId);
  const bindingId = pickString(selectorBindingId, selected.bindingId);
  const requireScopedSelector = options.requireScopedSelector === true;

  if (context.accountId) {
    if (!accountIds.length && requireScopedSelector) return false;
    if (accountIds.length && !accountIds.some((accountId) => sameContextValue(accountId, context.accountId))) return false;
  }
  if (context.chatId) {
    if (!chatId && requireScopedSelector) return false;
    if (chatId && !sameContextValue(chatId, context.chatId)) return false;
  }
  if (!recipientScopeMatchesSelector(chatId, context)) return false;
  if (context.bindingId) {
    if (!bindingId) return false;
    if (!sameContextValue(bindingId, context.bindingId)) return false;
  }
  return true;
}

export function whatsappBridgeTokenAllowsDirectSelector(action = "send", selector = {}, context = {}) {
  if (!["send", "send-media", "send-text"].includes(pickString(action).toLowerCase())) return false;
  if (!context || Object.keys(context).length === 0 || context.legacy === true) return false;
  const chatId = pickString(selector.chatId, selector.to);
  if (!chatId || !contextHasRecipientScope(context)) return false;
  return whatsappBridgeTokenContextMatchesSelector(selector, context, null, { requireScopedSelector: true });
}

export function assertWhatsAppBridgeTokenContext(action = "send", selector = {}, context = {}, binding = null, options = {}) {
  if (whatsappBridgeTokenContextMatchesSelector(selector, context, binding, options)) return;
  throw whatsappAclDeniedError(action, { ...(binding || {}), ...selector }, context);
}

export function whatsappBindingAclAllows(binding = {}, action = "send", context = null) {
  if (!context || Object.keys(context).length === 0) return true;
  if (context.legacy === true) return true;
  const acl = bindingAcl(binding)[action] || { mode: "owner-only", users: [] };
  const mode = pickString(acl.mode, "owner-only").toLowerCase();
  if (["all", "all-users", "public"].includes(mode)) return true;
  if (["none", "disabled", "deny", "deny-all"].includes(mode)) return false;
  if (mode === "thread") {
    return sameContextValue(context.bindingId, binding.bindingId || binding.id) ||
      sameContextValue(context.threadId, binding.threadId) ||
      sameContextValue(context.chatId, binding.chatId);
  }
  const values = contextValues(context);
  if (mode === "users") {
    return (acl.users || []).some((user) => values.includes(pickString(user).toLowerCase()));
  }
  if (mode === "owner-only" || mode === "owner") {
    const owner = pickString(binding.ownerUserId, binding.userId);
    return Boolean(owner && values.includes(owner.toLowerCase()));
  }
  return false;
}

export function whatsappAclDeniedError(action = "send", binding = {}, context = {}) {
  const error = new Error("wa_acl_denied");
  error.statusCode = 403;
  error.routingFailure = {
    code: "wa_acl_denied",
    capability: "whatsapp",
    provider: "whatsapp",
    userFacingCategory: "connector",
    retryable: false,
    safeMessage: "This WhatsApp binding does not allow the requested operation for this token.",
    reason: "wa_acl_denied",
    bindingId: pickString(binding.bindingId, binding.id),
    threadId: pickString(binding.threadId),
    chatId: pickString(binding.chatId),
    accountId: pickString(binding.accountId, context.accountId),
    principalKind: pickString(context.principalKind),
    principalId: pickString(context.principalId),
    instanceId: pickString(context.instanceId),
  };
  error.action = action;
  return error;
}
