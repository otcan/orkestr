import { Body, Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import { inspectVaultReceiveLink, submitVaultReceiveLink } from "../../../../../packages/core/src/vault-receive-links.js";
import { postAllowed, recordFailedLookup, throttled } from "./secret-link-pages.controller.js";
import { rateLimitedPage } from "./secret-link-pages.js";
import { vaultReceivePromptPage } from "./vault-receive-pages.js";
import { sendVaultShareJson, vaultShareUnavailablePage } from "./vault-share-pages.js";

// Public pages for Vault receive links (docs/vault-sharing.md). No login;
// the browser encrypts to the link's public key. One accepted submission per
// link. Unknown, used, revoked and expired tokens get the same 404, and
// unknown tokens or undecryptable envelopes count against the per-client
// lookup throttle shared with /s/<token>.
@Controller("s/r")
export class VaultReceivePagesController {
  @Get(":token")
  async view(@Req() request: any, @Param("token") token: string, @Res() response: any) {
    if (await throttled(request)) return rateLimitedPage(response);
    const result = await inspectVaultReceiveLink(token);
    if (result.state !== "active") {
      await recordFailedLookup(request);
      return vaultShareUnavailablePage(response);
    }
    return vaultReceivePromptPage(response, result.link, result.publicKey);
  }

  @Post(":token/submit")
  async submit(@Req() request: any, @Param("token") token: string, @Body() body: Record<string, unknown> = {}, @Res() response: any) {
    if (!postAllowed(request)) return sendVaultShareJson(response, 403, { ok: false, error: "origin_forbidden" });
    if (await throttled(request)) return sendVaultShareJson(response, 429, { ok: false, error: "rate_limited" });
    let envelope: unknown = null;
    try {
      envelope = typeof body?.envelope === "string" ? JSON.parse(body.envelope) : null;
    } catch {
      envelope = null;
    }
    let result: any;
    try {
      result = await submitVaultReceiveLink(token, envelope);
    } catch (error: any) {
      // Only value-free codes; never echo error text.
      const status = Number(error?.statusCode) === 413 ? 413 : Number(error?.statusCode) === 409 ? 409 : 400;
      return sendVaultShareJson(response, status, { ok: false, error: status === 413 ? "too_large" : "not_stored" });
    }
    if (result.state === "submitted") return sendVaultShareJson(response, 200, { ok: true });
    await recordFailedLookup(request);
    if (result.state === "invalid") return sendVaultShareJson(response, 400, { ok: false, error: "not_stored" });
    return sendVaultShareJson(response, 404, { ok: false, error: "not_found" });
  }
}
