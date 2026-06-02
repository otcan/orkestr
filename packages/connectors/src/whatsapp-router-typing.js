function clean(value) {
  return String(value || "").trim();
}

export function routedWhatsAppTypingTarget({ thread = {}, input = {} } = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  const chatId = clean(input.chatId || input.fromChatId || input.chat?.id || binding.chatId);
  if (!chatId) return null;
  return {
    chatId,
    accountId: clean(binding.responderAccountId || binding.outboundAccountId || binding.senderAccountId || input.accountId),
  };
}

export async function runWithRoutedWhatsAppTyping({ thread = {}, input = {}, env = process.env } = {}, action, dependencies = {}) {
  const target = routedWhatsAppTypingTarget({ thread, input });
  if (!target || typeof action !== "function") return typeof action === "function" ? action() : null;
  const startTyping = dependencies.startTyping;
  const stopTyping = dependencies.stopTyping;
  let started = false;
  if (typeof startTyping === "function") {
    const result = await startTyping({ ...target, env }).catch(() => null);
    started = result?.ok === true || result?.active === true;
  }
  try {
    return await action();
  } finally {
    if (started && typeof stopTyping === "function") {
      await stopTyping({ ...target, env }).catch(() => null);
    }
  }
}
