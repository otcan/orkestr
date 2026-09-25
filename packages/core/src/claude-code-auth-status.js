// Structured status is authoritative: words in JSON keys/messages are not
// evidence of authentication. Never treat login verification as quota proof.
export function claudeCodeStatusAuthenticated(stdout = "") {
  const output = String(stdout || "").trim();
  let parsed;
  try { parsed = JSON.parse(output); }
  catch {
    // Narrow compatibility for older text-only status output. Extra diagnostics,
    // negation, truncated JSON and stderr must not create a successful login.
    return /^(?:logged\s+in|authenticated)\.?$/i.test(output);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const status = String(parsed.status || "").trim().toLowerCase();
  if (parsed.loggedIn === false || parsed.authenticated === false ||
      ["not_logged_in", "logged_out", "unauthenticated", "login_required"].includes(status)) return false;
  return parsed.loggedIn === true || parsed.authenticated === true ||
    ["logged_in", "authenticated", "ready"].includes(status);
}
