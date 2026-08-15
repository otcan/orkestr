export function primaryInstanceUrl(env = process.env): string {
  const raw = String(env.ORKESTR_PRIMARY_INSTANCE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}
