import {
  canonicalInstanceAppSessionCookiePath,
  clearSessionCookieHeaders,
  instanceAppSessionCookiePath,
  oidcSecurityCookieName,
  revokeSecuritySession,
} from "../../../packages/core/src/security.js";

export async function logoutBrowserSession(
  request: any,
  response: any,
  { instanceId = "", instancePublicRef = "" } = {},
): Promise<void> {
  const session = request?.orkestrSecuritySession || null;
  const scopedInstanceId = String(instanceId || session?.instanceId || "").trim();
  const requestHost = String(request?.headers?.["x-forwarded-host"] || request?.headers?.host || "");
  response.setHeader("set-cookie", [
    ...clearSessionCookieHeaders(process.env, {
      requestHost,
      paths: [
        scopedInstanceId ? instanceAppSessionCookiePath(scopedInstanceId) : "",
        instancePublicRef ? canonicalInstanceAppSessionCookiePath(instancePublicRef) : "",
      ].filter(Boolean),
    }),
    ...clearSessionCookieHeaders(process.env, {
      name: oidcSecurityCookieName(),
      hostOnly: true,
      requestHost,
    }),
  ]);
  if (!session?.id) {
    response.status(200).type("application/json; charset=utf-8").send(JSON.stringify({ ok: true }));
    return;
  }
  if (session.instanceId && scopedInstanceId && String(session.instanceId) !== scopedInstanceId) {
    response.status(403).type("application/json; charset=utf-8").send(JSON.stringify({ ok: false, error: "browser_session_instance_mismatch" }));
    return;
  }
  await revokeSecuritySession(String(session.id), { env: process.env, revokedBy: "browser_logout" });
  response.status(200).type("application/json; charset=utf-8").send(JSON.stringify({ ok: true }));
}
