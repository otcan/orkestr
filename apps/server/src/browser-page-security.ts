// Shared helpers for small server-rendered pages (MCP consent, one-time
// secret links): HTML escaping and the same-origin check for form POSTs.

export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}

// Browser form posts must come from one of the expected origins. Pages that
// use "Referrer-Policy: no-referrer" make browsers send "Origin: null" on form
// POSTs, so a null/absent Origin is accepted only with the browser-controlled
// "Sec-Fetch-Site: same-origin" header, which page scripts cannot set.
export function sameOriginFormPost(request: any, expectedOrigins: string[]) {
  const fetchSite = String(request.headers?.["sec-fetch-site"] || "").trim().toLowerCase();
  const origin = String(request.headers?.origin || "").trim();
  if (origin && origin !== "null") {
    if (fetchSite && fetchSite !== "same-origin") return false;
    return expectedOrigins.filter(Boolean).some((expected) => origin.toLowerCase() === expected.toLowerCase());
  }
  return fetchSite === "same-origin";
}
