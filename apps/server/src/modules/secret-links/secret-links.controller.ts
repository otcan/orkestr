import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { requestPrincipal } from "../../../../../packages/core/src/principal.js";
import {
  createSecretRequestLink,
  createSecretShareLink,
  listSecretLinks,
  revokeSecretLink,
} from "../../../../../packages/core/src/secret-links.js";
import { agentThreadIdFromRequest } from "../../../../../packages/core/src/vault-access.js";
import { createVaultReceiveLink } from "../../../../../packages/core/src/vault-receive-links.js";
import { createVaultShareLink } from "../../../../../packages/core/src/vault-share-links.js";

// Authenticated API used by `orkestr secret share|request|links`. Responses
// carry link metadata and the one-time URL only, never a secret value.

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function linkInput(body: Record<string, unknown> = {}) {
  return {
    ttl: clean(body.ttl),
    label: clean(body.label),
    threadId: clean(body.threadId || body.thread),
    ownerUserId: clean(body.ownerUserId || body.userId),
  };
}

@Controller("api/secret-links")
export class SecretLinksController {
  @Get()
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async list(@Req() request: any, @Query() query: Record<string, unknown> = {}) {
    return listSecretLinks({ ownerUserId: clean(query.userId || query.ownerUserId), all: clean(query.all) }, requestPrincipal(request));
  }

  @Post("share")
  @HttpCode(201)
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async share(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const value = typeof body.value === "string" ? body.value : undefined;
    return createSecretShareLink({ ...linkInput(body), value, from: clean(body.from) }, requestPrincipal(request));
  }

  @Post("request")
  @HttpCode(201)
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async request(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return createSecretRequestLink({ ...linkInput(body), name: clean(body.name) }, requestPrincipal(request));
  }

  // End-to-end share: the body carries only the client-built envelope; the
  // decryption key never reaches the server (docs/vault-sharing.md).
  @Post("e2e")
  @HttpCode(201)
  @Header("X-Orkestr-Secure-Input", "noMirror,noCapture,noCodexContext,noScreenshot")
  async e2e(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const input = linkInput(body);
    // `orkestr vault share` sends the per-turn thread token: the link then
    // belongs to that thread's owner, like the vault item it came from.
    if (request.headers?.["x-orkestr-thread-token"]) input.threadId = await agentThreadIdFromRequest(request, input.threadId);
    return createVaultShareLink({ ...input, envelope: body.envelope, views: body.views, name: clean(body.name) }, requestPrincipal(request));
  }

  // Receive link for a person outside Orkestr; the submission becomes a Vault
  // item of the link owner (granted to the thread when created from one).
  @Post("e2e-request")
  @HttpCode(201)
  async e2eRequest(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    const input = linkInput(body);
    if (request.headers?.["x-orkestr-thread-token"]) input.threadId = await agentThreadIdFromRequest(request, input.threadId);
    return createVaultReceiveLink({ ...input, name: clean(body.name), once: body.once === true }, requestPrincipal(request));
  }

  @Post(":id/revoke")
  @HttpCode(200)
  async revoke(@Req() request: any, @Param("id") id: string) {
    return revokeSecretLink(id, requestPrincipal(request));
  }

  @Delete(":id")
  async remove(@Req() request: any, @Param("id") id: string) {
    return revokeSecretLink(id, requestPrincipal(request));
  }
}
