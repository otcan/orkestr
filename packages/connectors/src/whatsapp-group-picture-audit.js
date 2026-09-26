const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 10;

function clampConcurrency(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < CONCURRENCY_MIN) return CONCURRENCY_MIN;
  return Math.min(CONCURRENCY_MAX, parsed);
}

function isGroupChatId(chatId) {
  return /@g\.us$/i.test(String(chatId || ""));
}

async function runWithConcurrencyLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  const pool = Array.from({ length: Math.min(limit, tasks.length || 1) }, worker);
  await Promise.all(pool);
  return results;
}

async function auditSingleGroupPicture(client, chatId) {
  try {
    const url = await client.getProfilePicUrl(chatId);
    // Only emit status — no URL bytes or personal identifiers in results.
    return { chatId, status: url ? "present" : "missing" };
  } catch {
    return { chatId, status: "unknown" };
  }
}

export async function auditLocalWhatsAppGroupPictures({ client, chatIds = [], concurrency = 3 } = {}) {
  if (!client) throw Object.assign(new Error("whatsapp_picture_client_required"), { statusCode: 400 });
  const groupIds = chatIds.filter(isGroupChatId);
  if (!groupIds.length) return [];
  const bounded = clampConcurrency(concurrency);
  const tasks = groupIds.map((chatId) => () => auditSingleGroupPicture(client, chatId));
  return runWithConcurrencyLimit(tasks, bounded);
}
