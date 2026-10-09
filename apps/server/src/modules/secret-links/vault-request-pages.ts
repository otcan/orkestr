import { escapeHtml } from "../../browser-page-security.js";
import { sendSecretLinkPage } from "./secret-link-pages.js";

// Pages for "request into vault" links (kind "vault", docs/vault.md). Same
// headers and one-time rules as the other /s/<token> pages.

export function vaultRequestPromptPage(response: any, token: string, request: any) {
  const kind = request?.once
    ? "It is released to that thread's agent once and then destroyed (or when it expires)."
    : "It is saved in your Vault and assigned to that thread.";
  const username = request?.usernameToo
    ? `<label>Username<br><input name="username" type="text" maxlength="512" autocomplete="off" spellcheck="false"></label><br>`
    : "";
  return sendSecretLinkPage(response, 200, `Store "${request?.name || ""}" in your Vault`, `${request?.label ? `<p>${escapeHtml(request.label)}</p>` : ""}
<p>An Orkestr thread asks for the password <strong>${escapeHtml(request?.name)}</strong>. ${kind} The agent never sees it in chat.</p>
<p class="muted">This link works once and expires at ${escapeHtml(request?.expiresAt)}.</p>
<form method="post" action="/s/${escapeHtml(encodeURIComponent(token))}/vault">${username}
<label>Password<br><input name="password" type="password" maxlength="4096" required autocomplete="off"></label><br>
<button type="submit">Store in Vault</button></form>`);
}

export function vaultStoredPage(response: any, request: any) {
  return sendSecretLinkPage(response, 200, "Stored in your Vault", `<p><strong>${escapeHtml(request?.name)}</strong> was stored in your Vault${request?.once ? " as a single-use item" : ""} and assigned to the requesting thread. This link is now used up.</p>`);
}
