import fs from "node:fs/promises";
import path from "node:path";

const target = String(process.env.ORKESTR_CLAUDE_STATUS_CAPTURE_PATH || "").trim();
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(0);
}

try {
  const value = JSON.parse(input);
  const finite = (candidate) => candidate !== null && candidate !== undefined && candidate !== "" && Number.isFinite(Number(candidate)) && Number(candidate) >= 0 ? Number(candidate) : null;
  const rateWindow = (candidate) => candidate && typeof candidate === "object" ? {
    used_percentage: finite(candidate.used_percentage),
    resets_at: finite(candidate.resets_at),
  } : null;
  const safe = {
    observedAt: new Date().toISOString(),
    model: typeof value.model?.id === "string" ? { id: value.model.id.slice(0, 120) } : null,
    effort: typeof value.effort?.level === "string" ? { level: value.effort.level.slice(0, 16) } : null,
    context_window: value.context_window && typeof value.context_window === "object" ? {
      context_window_size: finite(value.context_window.context_window_size),
      current_usage: value.context_window.current_usage && typeof value.context_window.current_usage === "object" ? {
        input_tokens: finite(value.context_window.current_usage.input_tokens),
        output_tokens: finite(value.context_window.current_usage.output_tokens),
        cache_creation_input_tokens: finite(value.context_window.current_usage.cache_creation_input_tokens),
        cache_read_input_tokens: finite(value.context_window.current_usage.cache_read_input_tokens),
      } : null,
    } : null,
    rate_limits: value.rate_limits && typeof value.rate_limits === "object" ? {
      five_hour: rateWindow(value.rate_limits.five_hour),
      seven_day: rateWindow(value.rate_limits.seven_day),
    } : null,
  };
  if (target) {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(safe), { mode: 0o600 });
    await fs.rename(temporary, target);
  }
} catch {}
