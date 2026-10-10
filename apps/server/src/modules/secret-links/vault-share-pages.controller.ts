import { Controller, Get, Param, Post, Req, Res } from "@nestjs/common";
import { inspectVaultShareLink, openVaultShareLink } from "../../../../../packages/core/src/vault-share-links.js";
import { postAllowed, recordFailedLookup, throttled } from "./secret-link-pages.controller.js";
import { rateLimitedPage } from "./secret-link-pages.js";
import { sendVaultShareJson, vaultSharePromptPage, vaultShareUnavailablePage } from "./vault-share-pages.js";

// Public pages for end-to-end vault share links (docs/vault-sharing.md). No
// login: possession of the link is the capability, and the decryption key
// stays in the URL fragment. GET never consumes a view. Unknown, used,
// revoked and expired tokens all get the same 404 and count against the
// per-client lookup throttle shared with /s/<token>.
@Controller("s/e")
export class VaultSharePagesController {
  @Get(":token")
  async view(@Req() request: any, @Param("token") token: string, @Res() response: any) {
    if (await throttled(request)) return rateLimitedPage(response);
    const result = await inspectVaultShareLink(token);
    if (result.state !== "active") {
      await recordFailedLookup(request);
      return vaultShareUnavailablePage(response);
    }
    return vaultSharePromptPage(response, result.link);
  }

  @Post(":token/open")
  async open(@Req() request: any, @Param("token") token: string, @Res() response: any) {
    if (!postAllowed(request)) return sendVaultShareJson(response, 403, { ok: false, error: "origin_forbidden" });
    if (await throttled(request)) return sendVaultShareJson(response, 429, { ok: false, error: "rate_limited" });
    const result = await openVaultShareLink(token);
    if (result.state !== "opened") {
      await recordFailedLookup(request);
      return sendVaultShareJson(response, 404, { ok: false, error: "not_found" });
    }
    return sendVaultShareJson(response, 200, { ok: true, envelope: result.envelope });
  }
}
