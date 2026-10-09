// HTTP route templates for metrics labels, access logs and the perf log.
// Labels and log lines must never carry ids, tokens, phone numbers or file
// names, so dynamic path segments collapse to placeholders.

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

export function routeTemplateFromUrl(rawUrl = "") {
  const pathname = clean(String(rawUrl || "").split("?")[0]) || "/";
  if (pathname === "/") return "/";
  const parts = pathname.split("/").filter(Boolean);
  const normalized = [];
  for (let index = 0; index < parts.length; index += 1) {
    const previous = lower(parts[index - 1]);
    const current = safeRouteSegment(parts[index]);
    if (previous === "threads") normalized.push(":threadId");
    else if (previous === "task-agents") normalized.push(":taskAgentId");
    else if (previous === "tenant-vms") normalized.push(":tenantVmId");
    else if (previous === "tenant-slices") normalized.push(":tenantSliceId");
    else if (previous === "browser-sessions") normalized.push(":desktopSlug");
    else if (previous === "browsers") normalized.push(":desktopSlug");
    else if (previous === "desktops" && current !== "leases") normalized.push(":desktopSlug");
    else if (previous === "desktop") normalized.push(":desktopSlug");
    else if (previous === "desktop-shares") normalized.push(":shareId");
    else if (previous === "router-traces") normalized.push(":routerTraceId");
    else if (previous === "accounts") normalized.push(":accountId");
    else if (previous === "attachments") normalized.push(":attachmentId");
    else if (previous === "leases") normalized.push(":leaseId");
    else if (previous === "i" || previous === "a" || previous === "s") normalized.push(":id");
    else if (looksDynamicSegment(current)) normalized.push(":id");
    else normalized.push(current);
  }
  return `/${normalized.join("/")}`;
}

function safeRouteSegment(segment = "") {
  try {
    return decodeURIComponent(clean(segment));
  } catch {
    return clean(segment);
  }
}

function looksDynamicSegment(segment = "") {
  const value = clean(segment);
  if (!value) return false;
  if (value.includes("@")) return true;
  if (/^[0-9a-f]{12,}$/i.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/^(att|co|desk|task|turn|msg|msgx|exec|lease)[-_][a-z0-9_-]+$/i.test(value)) return true;
  return value.length > 40 && /[0-9]/.test(value);
}

// redactedRouteTemplate: routeTemplateFromUrl plus a stricter allowlist pass,
// used for /metrics labels, access logs and the durable perf log. Only
// segments shaped like static route words survive (lowercase letters, dots,
// hyphens, or a short word with a version digit, as every controller path
// uses). Anything else (tokens, user ids, phone numbers,
// chat ids, file names) becomes :id, and the segment after /users/ is always
// :userId unless it is a fixed sub-route.
const STATIC_SEGMENT = /^(?:\.?[a-z][a-z.-]{0,39}|[a-z]{1,12}[0-9]{1,2})$/;
const ID_PARENTS = new Map([
  ["users", ["me", "credit-usage"]],
  ["chats", []],
  ["desktop-share", []],
]);

function perfSegment(segment, previous) {
  if (segment.startsWith(":")) return segment;
  const fixed = ID_PARENTS.get(previous);
  if (fixed && !fixed.includes(segment)) return previous === "users" ? ":userId" : ":id";
  return STATIC_SEGMENT.test(segment) ? segment : ":id";
}

export function redactedRouteTemplate(rawUrl = "") {
  const route = routeTemplateFromUrl(rawUrl)
    .split("/")
    .map((segment, index, parts) => (index === 0 ? segment : perfSegment(segment, parts[index - 1])))
    .join("/");
  return route.length > 160 ? `${route.slice(0, 157)}...` : route;
}
