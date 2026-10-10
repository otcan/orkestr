import crypto from "node:crypto";
import { createRequire } from "node:module";
import { escapeHtml } from "../../browser-page-security.js";

// Server-rendered pages for one-time secret links (docs/secret-links.md).
// Every response carries no-store, no-referrer, frame and sniffing guards, a
// nonce-only CSP and the secure-input no-mirror/no-capture hint.

const { urlencoded } = createRequire(import.meta.url)("express");

/** Form parser for /s/* POSTs; sized for a 16 KiB value after URL encoding. */
export function secretLinkFormBodyParser() {
  const parser = urlencoded({ extended: false, limit: "64kb", parameterLimit: 10 });
  // Distinct name: Nest skips its own parser registration when it finds one
  // of its built-in parser names already installed.
  return function secretLinkScopedFormParser(request: any, response: any, next: any) {
    return parser(request, response, next);
  };
}

export function sendSecretLinkPage(response: any, status: number, title: string, body: string, options: { script?: string; location?: string; connect?: boolean } = {}) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const script = options.script ? `<script nonce="${nonce}">${options.script}</script>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1.2rem;margin:.6rem .6rem 0 0}textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:.95rem}.muted{color:#555}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}${script}</body></html>`;
  response.status(status)
    .header("cache-control", "no-store, max-age=0")
    .header("pragma", "no-cache")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex, nofollow")
    .header("x-orkestr-secure-input", "noMirror,noCapture,noCodexContext,noScreenshot")
    .header("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';${options.connect ? " connect-src 'self';" : ""} form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
  if (options.location) response.header("location", options.location);
  return response.type("text/html; charset=utf-8").send(html);
}

function expiry(link: any) {
  return link?.expiresAt ? `<p class="muted">This link works once and expires at ${escapeHtml(link.expiresAt)}.</p>` : "";
}

function labelLine(link: any) {
  return link?.label ? `<p>${escapeHtml(link.label)}</p>` : "";
}

export function sharePromptPage(response: any, token: string, link: any) {
  return sendSecretLinkPage(response, 200, "A secret was shared with you", `${labelLine(link)}
<p>Orkestr shared a secret with you. It is shown once; after you reveal it the stored copy is destroyed.</p>${expiry(link)}
<form method="post" action="/s/${escapeHtml(encodeURIComponent(token))}/reveal"><button type="submit">Reveal</button></form>`);
}

export function revealedPage(response: any, link: any, value: string) {
  const script = `document.getElementById("copy").addEventListener("click",function(){var f=document.getElementById("secret-value");f.select();if(navigator.clipboard){navigator.clipboard.writeText(f.value).catch(function(){document.execCommand("copy");});}else{document.execCommand("copy");}this.textContent="Copied";});`;
  return sendSecretLinkPage(response, 200, "Your secret", `${labelLine(link)}
<p>This is the only time this secret is shown. Copy it now; reloading this page will not show it again.</p>
<textarea id="secret-value" rows="4" readonly autocomplete="off" spellcheck="false">${escapeHtml(value)}</textarea>
<button type="button" id="copy">Copy</button>`, { script });
}

export function requestPromptPage(response: any, token: string, link: any) {
  return sendSecretLinkPage(response, 200, `Provide the secret "${link?.name || ""}"`, `${labelLine(link)}
<p>Orkestr asks you for the secret <strong>${escapeHtml(link?.name)}</strong>. It is stored encrypted as <code>${escapeHtml(link?.handle)}</code>; agents use it by reference and never see it in chat.</p>${expiry(link)}
<form method="post" action="/s/${escapeHtml(encodeURIComponent(token))}/submit">
<textarea name="value" rows="4" maxlength="16384" required autocomplete="off" spellcheck="false"></textarea>
<button type="submit">Store secret</button></form>`);
}

export function submittedPage(response: any, link: any) {
  return sendSecretLinkPage(response, 200, "Secret stored", `<p>The secret <strong>${escapeHtml(link?.name)}</strong> was stored as <code>${escapeHtml(link?.handle)}</code>. This link is now used up.</p>`);
}

export function endedPage(response: any) {
  return sendSecretLinkPage(response, 410, "Link already used or expired", "<p>This one-time link was already used, revoked, or has expired. Ask for a new link if you still need it.</p>");
}

export function unavailablePage(response: any) {
  return sendSecretLinkPage(response, 404, "Link not available", "<p>This link is not available for the signed-in account.</p>");
}

export function signInPage(response: any, location = "") {
  if (location) return sendSecretLinkPage(response, 302, "Sign in", "<p>Redirecting to sign in.</p>", { location });
  return sendSecretLinkPage(response, 401, "Sign in required", "<p>Sign in to Orkestr in this browser first, then open the link again.</p>");
}

export function forbiddenOriginPage(response: any) {
  return sendSecretLinkPage(response, 403, "Not allowed", "<p>This action must be submitted from the Orkestr link page.</p>");
}

export function rateLimitedPage(response: any) {
  return sendSecretLinkPage(response, 429, "Too many attempts", "<p>Too many invalid link attempts. Try again later.</p>");
}

export function invalidValuePage(response: any, status: number, message: string) {
  return sendSecretLinkPage(response, status, "Secret not stored", `<p>${escapeHtml(message)}</p><p>Go back and try again; the link is still valid.</p>`);
}
