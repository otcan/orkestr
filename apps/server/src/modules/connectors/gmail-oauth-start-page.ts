import { openUrlInVirtualBrowser } from "../../../../../packages/browsers/src/browsers.js";
import { startGmailOAuth } from "../../../../../packages/connectors/src/gmail.js";
import { appendEvent } from "../../../../../packages/storage/src/store.js";
import { authenticatedAdminPrincipal } from "../../request-security.js";
import { consumeGmailOAuthIntent, createGmailOAuthIntent } from "./gmail-oauth-intents.js";

// Legacy browser entry /oauth/gmail/start (ORK-512).
//
// GET is side-effect free for OAuth state: it requires an authenticated
// administrator and renders a confirmation form carrying a one-time intent.
// Only the explicit POST from that form consumes the intent, writes OAuth
// state, and may open a managed virtual browser. Anonymous requests never
// reach OAuth state or the browser.

export const gmailOAuthStartPagePurpose = "oauth_start_page";

type BrowserOpener = (slug: string, url: string) => Promise<any>;
let browserOpenerForTest: BrowserOpener | null = null;

/** Test hook: replace the managed virtual browser with an isolated stub. */
export function setGmailOAuthBrowserOpenerForTest(opener: BrowserOpener | null): void {
  browserOpenerForTest = opener;
}

export interface OAuthStartPageResult {
  status: number;
  html?: string;
  redirect?: string;
  desktopSlug?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #061007; color: #eaffdf; font-family: Inter, system-ui, sans-serif; }
    main { width: min(560px, calc(100% - 32px)); padding: 28px; border: 1px solid rgba(128, 210, 138, .24); border-radius: 24px; background: #0d180f; }
    button, a { display: inline-flex; margin-top: 14px; padding: 10px 14px; border: 0; border-radius: 999px; color: #061007; background: #a8ffb2; font-weight: 800; text-decoration: none; cursor: pointer; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
}

export function oauthStartDeniedPage(): string {
  return page("Sign in required", `<p>Sign in to Orkestr as an administrator to connect Gmail.</p><a href="/setup/gmail">Open Mail Setup</a>`);
}

/** GET /oauth/gmail/start: mint an intent and render the confirmation form. */
export async function renderGmailOAuthStartPage(request: any, account = "", env = process.env): Promise<OAuthStartPageResult> {
  if (!authenticatedAdminPrincipal(request)) {
    await appendEvent({ type: "gmail_oauth_start_rejected", reason: "authentication_required", purpose: gmailOAuthStartPagePurpose }, env).catch(() => {});
    return { status: 401, html: oauthStartDeniedPage() };
  }
  if (String(request?.method || "GET").toUpperCase() === "HEAD") return { status: 200, html: "" };
  const intent = await createGmailOAuthIntent(request, { account }, env, { purpose: gmailOAuthStartPagePurpose });
  const hidden = [
    `<input type="hidden" name="intentId" value="${escapeHtml(intent.intentId)}">`,
    `<input type="hidden" name="token" value="${escapeHtml(intent.token)}">`,
    `<input type="hidden" name="account" value="${escapeHtml(String(account || "").trim().toLowerCase())}">`,
  ].join("");
  return {
    status: 200,
    html: page("Connect Gmail", `<p>Continue to Google to authorize Gmail${account ? ` for ${escapeHtml(account)}` : ""}.</p>
<form method="post" action="/oauth/gmail/start">${hidden}<button type="submit">Continue to Google</button></form>`),
  };
}

/** POST /oauth/gmail/start: consume the intent, start OAuth, optionally open the desk. */
export async function submitGmailOAuthStart(
  request: any,
  body: Record<string, unknown> = {},
  env = process.env,
  resolveDesktopSlug: (payload: any) => Promise<string> = async () => "",
): Promise<OAuthStartPageResult> {
  if (!authenticatedAdminPrincipal(request)) {
    await appendEvent({ type: "gmail_oauth_start_rejected", reason: "authentication_required", purpose: gmailOAuthStartPagePurpose }, env).catch(() => {});
    return { status: 401, html: oauthStartDeniedPage() };
  }
  let consumed;
  try {
    consumed = await consumeGmailOAuthIntent(request, body, env, { purpose: gmailOAuthStartPagePurpose });
  } catch (error: any) {
    return { status: Number(error?.statusCode || 403) || 403, html: page("Gmail auth not started", `<p>This Gmail authorization link is invalid or has already been used.</p><a href="/setup/gmail">Open Mail Setup</a>`) };
  }
  let started: any;
  try {
    started = await startGmailOAuth(env, { account: String(consumed.params.account || ""), principal: consumed.principal });
  } catch (error: any) {
    return { status: 500, html: page("Gmail auth failed", `<p>${escapeHtml(error?.message || "Gmail OAuth start failed.")}</p>`) };
  }
  const desktopSlug = await resolveDesktopSlug(started);
  if (!desktopSlug) return { status: 302, redirect: started.authorizeUrl };
  const opener = browserOpenerForTest || ((slug: string, url: string) => openUrlInVirtualBrowser(slug, url, env));
  let browser: any;
  try {
    browser = await opener(desktopSlug, started.authorizeUrl);
  } catch (error: any) {
    return {
      status: Number(error?.statusCode || 502) || 502,
      desktopSlug,
      html: page("Gmail auth failed", `<p>${escapeHtml(error?.message || "The virtual browser could not be opened.")}</p><a href="${escapeHtml(started.authorizeUrl)}">Open Google authorization</a>`),
    };
  }
  return {
    status: 200,
    desktopSlug,
    html: page("Gmail auth opened", `<p>Gmail authorization opened in ${escapeHtml(browser?.label || desktopSlug)}. Finish the Google login in that virtual browser.</p>${browser?.desk_url ? `<a href="${escapeHtml(browser.desk_url)}">Open Virtual Browser</a>` : ""}`),
  };
}
