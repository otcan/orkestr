/** Staged canonical OXRM leaf, NOT registered. No DB/tools/imports or credentials. */
export const SCOPE_STATUS_PATH = "/status/linkedin-outreach";

type Scope = Readonly<{ outreachWorkspaceId: string; linkedinAccountAlias: string }>;
export type StatusPrincipal = Readonly<{
  subject: string;
  scope: Scope;
  canReadScopeStatus: true;
}>;
export type StatusRequest = Readonly<{ method: string; url: string; body?: unknown }>;
export type StatusResult = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
}>;
export type StatusDependencies = Readonly<{
  configuredScope: Scope | undefined;
  /** Must verify current original caller, no refresh/initialization/fallback. */
  authenticate: (request: StatusRequest) => Promise<StatusPrincipal | null>;
  /** Actual createCrmServices result; descriptors inspected, never invoked. */
  serviceSurface: object;
}>;

const headers = Object.freeze({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
const methods = Object.freeze({
  recipient_claim: "claimOutreachRecipients",
  outcome_recording: "recordOutreachEvent",
  scoped_lead_query: "listXrmRecords",
});
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 && value.trim() === value && !/[\u0000-\u0020\u007f]/u.test(value);
}
function scope(value: unknown): Scope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<Scope>;
  return identity(v.outreachWorkspaceId) && identity(v.linkedinAccountAlias)
    ? Object.freeze({ outreachWorkspaceId: v.outreachWorkspaceId, linkedinAccountAlias: v.linkedinAccountAlias })
    : undefined;
}
function same(a: Scope, b: Scope): boolean {
  return a.outreachWorkspaceId === b.outreachWorkspaceId && a.linkedinAccountAlias === b.linkedinAccountAlias;
}
function refusal(statusCode: number, error: string): StatusResult {
  return { statusCode, headers, body: { format_version: 1, status: "refused", error } };
}
function principal(value: unknown): StatusPrincipal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<StatusPrincipal>;
  const pair = scope(v.scope);
  return identity(v.subject) && v.canReadScopeStatus === true && pair
    ? Object.freeze({ subject: v.subject, scope: pair, canReadScopeStatus: true }) : undefined;
}

/** Does not register a route or supply an unauthenticated default principal. */
export function createScopeStatus(deps: StatusDependencies): (request: StatusRequest) => Promise<StatusResult> {
  if (!deps || typeof deps.authenticate !== "function" || !deps.serviceSurface ||
      typeof deps.serviceSurface !== "object") throw new TypeError("explicit_status_authority_required");
  const configured = scope(deps.configuredScope);
  // Copy the canonical configured pair. Missing/partial configuration stays held.
  // No callable is executed, including property accessors supplied by a surface.
  const coverage = Object.freeze(Object.fromEntries(Object.entries(methods).map(([capability, method]) => {
    const descriptor = Object.getOwnPropertyDescriptor(deps.serviceSurface, method);
    return [capability, Object.freeze({
      availability: typeof descriptor?.value === "function" ? "callable_surface_present" : "not_observed",
      behavioral_assurance: "not_exercised",
    })];
  })));
  const authenticate = deps.authenticate;
  return async (request) => {
    if (request.method !== "GET") return refusal(405, "method_not_allowed");
    if (typeof request.url !== "string" || request.url.length > 2048 ||
        request.url.startsWith("//") || !request.url.startsWith("/") ||
        request.body !== undefined && request.body !== null) return refusal(400, "request_invalid");
    let url: URL;
    try { url = new URL(request.url, "http://status.example.invalid"); }
    catch { return refusal(400, "request_invalid"); }
    if (url.origin !== "http://status.example.invalid" || url.pathname !== SCOPE_STATUS_PATH || url.hash) return refusal(404, "status_transport_unsupported");
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || new Set(keys).size !== 2 ||
        keys.some(k => k !== "outreachWorkspaceId" && k !== "linkedinAccountAlias")) return refusal(400, "scope_required");
    const requested = scope({ outreachWorkspaceId: url.searchParams.get("outreachWorkspaceId"),
      linkedinAccountAlias: url.searchParams.get("linkedinAccountAlias") });
    if (!requested) return refusal(400, "scope_required");
    let before: StatusPrincipal | undefined;
    try { before = principal(await authenticate(request)); }
    catch { return refusal(503, "authority_unavailable"); }
    if (!before) return refusal(401, "authentication_required");
    if (!configured) return refusal(409, "scope_not_configured");
    if (!same(before.scope, configured) || !same(requested, configured)) return refusal(403, "scope_mismatch");
    let after: StatusPrincipal | undefined;
    try { after = principal(await authenticate(request)); }
    catch { return refusal(503, "authority_unavailable"); }
    if (!after) return refusal(401, "authentication_required");
    if (after.subject !== before.subject || !same(after.scope, before.scope)) return refusal(403, "caller_changed");
    return { statusCode: 200, headers, body: {
      format_version: 1, status: "scope_attested", scope: configured,
      coverage: { scope_configuration: "attested", capabilities: coverage },
      activity_proven: false, workflow_ready: false,
    } };
  };
}
