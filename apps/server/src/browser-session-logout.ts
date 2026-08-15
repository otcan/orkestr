import {
  canonicalInstanceAppSessionCookiePath,
  clearSessionCookieHeaders,
  instanceAppSessionCookiePath,
  revokeSecuritySession,
} from "../../../packages/core/src/security.js";

export async function logoutBrowserSession(
  request: any,
  response: any,
  { instanceId = "", instancePublicRef = "" } = {},
): Promise<void> {
  const session = request?.orkestrSecuritySession || null;
  if (!session?.id) {
    if (request?.orkestrMachineAuth === "trusted_operator_proxy") {
      response.status(200).type("application/json; charset=utf-8").send(JSON.stringify({ ok: true }));
      return;
    }
    response.status(401).type("application/json; charset=utf-8").send(JSON.stringify({ ok: false, error: "browser_session_required" }));
    return;
  }
  const scopedInstanceId = String(instanceId || session.instanceId || "").trim();
  if (session.instanceId && scopedInstanceId && String(session.instanceId) !== scopedInstanceId) {
    response.status(403).type("application/json; charset=utf-8").send(JSON.stringify({ ok: false, error: "browser_session_instance_mismatch" }));
    return;
  }
  await revokeSecuritySession(String(session.id), { env: process.env, revokedBy: "browser_logout" });
  const requestHost = String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "");
  response.setHeader("set-cookie", clearSessionCookieHeaders(process.env, {
    requestHost,
    paths: [
      scopedInstanceId ? instanceAppSessionCookiePath(scopedInstanceId) : "",
      instancePublicRef ? canonicalInstanceAppSessionCookiePath(instancePublicRef) : "",
    ].filter(Boolean),
  }));
  response.status(200).type("application/json; charset=utf-8").send(JSON.stringify({ ok: true }));
}
