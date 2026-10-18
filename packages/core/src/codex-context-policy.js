// Optional host/per-thread bound for native Codex history compaction. Keep the
// model, effort, context-window capacity and full stored transcript unchanged.
export function codexContextOverrides(thread = {}, env = process.env) {
  const raw = thread.codexAutoCompactTokenLimit ?? env.ORKESTR_CODEX_AUTO_COMPACT_TOKEN_LIMIT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return {};
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 8192) return {};
  return { config: { model_auto_compact_token_limit: limit } };
}
