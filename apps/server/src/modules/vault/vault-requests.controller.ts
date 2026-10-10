import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { agentThreadIdFromRequest } from "../../../../../packages/core/src/vault-access.js";
import { createVaultRequestLink, listVaultRequests, revokeVaultRequest } from "../../../../../packages/core/src/vault-requests.js";
import { vaultAgent, vaultOwner } from "./vault-request.js";

// "Request into vault" (docs/vault.md): the agent creates a one-time link
// for its own thread (thread token); the owner lists and revokes pending
// requests from the Vault page. No route here accepts or returns a value.

type JsonBody = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

@Controller("api/vault")
export class VaultRequestsController {
  @Post("agent/requests")
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: JsonBody = {}) {
    vaultAgent(request);
    const threadId = await agentThreadIdFromRequest(request, text(body?.threadId));
    return createVaultRequestLink(threadId, {
      name: text(body?.name),
      ttl: text(body?.ttl),
      label: text(body?.label),
      once: body?.once === true,
      usernameToo: body?.usernameToo === true,
    });
  }

  @Get("requests")
  async list(@Req() request: any) {
    return listVaultRequests(vaultOwner(request));
  }

  @Post("requests/:id/revoke")
  @HttpCode(200)
  async revoke(@Req() request: any, @Param("id") id: string) {
    return revokeVaultRequest(vaultOwner(request, { mutating: true }), id);
  }
}
