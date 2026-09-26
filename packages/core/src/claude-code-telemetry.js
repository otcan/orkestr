function clean(value = "") {
  return String(value || "").trim();
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function mergeClaudeCodeRateLimits(current = null, observed = null) {
  if (!observed) return current || null;
  const mergeWindow = (previous, next) => {
    if (!next) return previous || null;
    if (!previous) return next;
    const previousReset = finite(previous.resets_at);
    const nextReset = finite(next.resets_at);
    const sameWindow = previousReset === null || nextReset === null || previousReset === nextReset;
    return sameWindow ? { ...previous, ...next } : next;
  };
  return {
    primary: mergeWindow(current?.primary, observed.primary),
    secondary: mergeWindow(current?.secondary, observed.secondary),
    plan_type: observed.plan_type || current?.plan_type || "claude_subscription",
  };
}

export function claudeCodeEventTelemetry(event = {}) {
  const usage = event.usage || event.message?.usage || event.context_window?.current_usage || null;
  const input = finite(usage?.input_tokens);
  const output = finite(usage?.output_tokens);
  const cacheWrite = finite(usage?.cache_creation_input_tokens);
  const cacheRead = finite(usage?.cache_read_input_tokens);
  const tokenUsage = usage ? {
    ...(input !== null ? { input_tokens: input } : {}),
    ...(output !== null ? { output_tokens: output } : {}),
    ...(cacheWrite !== null ? { cache_creation_input_tokens: cacheWrite } : {}),
    ...(cacheRead !== null ? { cache_read_input_tokens: cacheRead } : {}),
    ...([input, cacheWrite, cacheRead].some((value) => value !== null)
      ? { total_tokens: (input || 0) + (cacheWrite || 0) + (cacheRead || 0) }
      : {}),
  } : null;
  const limits = event.rate_limits || event.rateLimits || null;
  const window = (value, minutes) => {
    const used = finite(value?.used_percentage ?? value?.used_percent);
    const reset = finite(value?.resets_at);
    return used === null ? null : { used_percent: Math.min(100, used), window_minutes: minutes, ...(reset !== null ? { resets_at: reset } : {}) };
  };
  let rateLimits = limits ? {
    primary: window(limits.five_hour || limits.primary, 300),
    secondary: window(limits.seven_day || limits.weekly || limits.secondary, 10080),
    plan_type: "claude_subscription",
  } : null;
  const providerLimit = event.rate_limit_info || event.rateLimitInfo || null;
  const unifiedWindows = providerLimit?.unifiedWindows || providerLimit?.unified_windows || null;
  const unifiedWindow = (value, minutes) => {
    const utilization = finite(value?.utilization);
    if (utilization === null) return null;
    const reset = finite(value?.resetsAt ?? value?.resets_at);
    return {
      used_percent: Math.min(100, Math.round(utilization * 10_000) / 100),
      window_minutes: minutes,
      ...(reset !== null ? { resets_at: reset } : {}),
    };
  };
  const unifiedFiveHour = unifiedWindow(unifiedWindows?.five_hour, 300);
  const unifiedSevenDay = unifiedWindow(unifiedWindows?.seven_day, 10080);
  if (unifiedFiveHour || unifiedSevenDay) {
    rateLimits = {
      primary: unifiedFiveHour || rateLimits?.primary || null,
      secondary: unifiedSevenDay || rateLimits?.secondary || null,
      plan_type: "claude_subscription",
    };
  }
  const providerLimitType = clean(providerLimit?.rateLimitType || providerLimit?.rate_limit_type).toLowerCase();
  const providerLimitStatus = clean(providerLimit?.status).toLowerCase();
  if (["allowed", "rejected"].includes(providerLimitStatus) && ["five_hour", "seven_day"].includes(providerLimitType)) {
    const reset = finite(providerLimit?.resetsAt ?? providerLimit?.resets_at);
    const currentWindow = providerLimitType === "five_hour" ? rateLimits?.primary : rateLimits?.secondary;
    const providerWindow = {
      ...(currentWindow || {}),
      status: providerLimitStatus,
      window_minutes: providerLimitType === "five_hour" ? 300 : 10080,
      ...(providerLimitStatus === "rejected" ? { used_percent: 100 } : {}),
      ...(reset !== null ? { resets_at: reset } : {}),
    };
    rateLimits = {
      primary: providerLimitType === "five_hour" ? providerWindow : rateLimits?.primary || null,
      secondary: providerLimitType === "seven_day" ? providerWindow : rateLimits?.secondary || null,
      plan_type: "claude_subscription",
    };
  }
  const contextSize = finite(event.context_window?.context_window_size);
  return {
    tokenUsage: tokenUsage && Object.keys(tokenUsage).length ? tokenUsage : null,
    rateLimits: rateLimits?.primary || rateLimits?.secondary ? rateLimits : null,
    contextWindow: contextSize && contextSize > 0 ? contextSize : null,
    model: validModelTelemetry(event.model?.id || event.model || event.message?.model),
  };
}

export function mergeClaudeCodeTelemetry(current = {}, observed = {}) {
  return {
    tokenUsage: observed.tokenUsage || current.tokenUsage || null,
    rateLimits: mergeClaudeCodeRateLimits(current.rateLimits, observed.rateLimits),
    contextWindow: observed.contextWindow || current.contextWindow || null,
    model: observed.model || current.model || null,
  };
}

function validModelTelemetry(value = "") {
  value = clean(value);
  return /^[a-zA-Z0-9._:-]{1,120}$/.test(value) ? value : null;
}
