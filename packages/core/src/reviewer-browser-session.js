import { createHmac } from "node:crypto";

const clean = value => String(value || "").trim();
const enabled = env => ["1", "true", "yes", "on"].includes(clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_ENABLED).toLowerCase());
const reviewerUser = env => clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_USER_ID) || "google-reviewer";

function binding(env) {
  const secret = clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ACCESS_SECRET);
  const password = clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PASSWORD);
  if (!enabled(env) || secret.length < 32 || password.length < 16) return "";
  // Neither the password nor the signing key is persisted in a session. Bind
  // the entry configuration and local instance so changing either revokes it.
  return createHmac("sha256", secret).update(JSON.stringify([
    password, reviewerUser(env), clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_THREAD_ID) || "google-oauth-reviewer",
    clean(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_PUBLIC_URL), clean(env.ORKESTR_HOME),
  ])).digest("hex");
}

export function reviewerBrowserSessionFields(userId, env = process.env) {
  const reviewBinding = binding(env);
  if (!reviewBinding || clean(userId) !== reviewerUser(env)) {
    throw Object.assign(new Error("google_workspace_review_session_not_configured"), { statusCode: 403 });
  }
  const configured = Number(env.ORKESTR_GOOGLE_WORKSPACE_REVIEW_ENV_TTL_MINUTES || 240);
  const minutes = Math.max(5, Math.min(1440, Number.isFinite(configured) ? configured : 240));
  return { authProvider: "google_workspace_review", reviewBinding, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() };
}

export function reviewerBrowserSessionActive(session, env = process.env) {
  if (session.authProvider !== "google_workspace_review") {
    // Previously issued reviewer password sessions had the ordinary 90-day
    // lifetime. Require a fresh password sign-in instead of grandfathering them.
    return !(enabled(env) && clean(session.userId) === reviewerUser(env));
  }
  const expected = binding(env);
  return Boolean(expected) && session.reviewBinding === expected && clean(session.userId) === reviewerUser(env);
}
