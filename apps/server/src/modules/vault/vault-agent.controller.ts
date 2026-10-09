import { Body, Controller, Get, Header, HttpCode, Post, Query, Req } from "@nestjs/common";
import { agentThreadIdFromRequest } from "../../../../../packages/core/src/vault-access.js";
import { agentListItems, agentReadSecret, agentRequestTotp } from "../../../../../packages/core/src/vault-agent.js";
import { SECURE_RESPONSE_HEADER, vaultAgent } from "./vault-request.js";

// Agent API used only by `orkestr vault` (local CLI machine credential). The
// thread comes from the per-turn thread token and selects which grants apply;
// the vault is the thread owner's.

type JsonBody = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

@Controller("api/vault/agent")
export class VaultAgentController {
  @Get("items")
  async list(@Req() request: any, @Query() query: JsonBody = {}) {
    vaultAgent(request);
    return agentListItems(await agentThreadIdFromRequest(request, text(query.threadId)));
  }

  @Post("credentials")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async credentials(@Req() request: any, @Body() body: JsonBody = {}) {
    vaultAgent(request);
    const fields = Array.isArray(body?.fields) ? body.fields.map(text) : ["username", "password"];
    return agentReadSecret(await agentThreadIdFromRequest(request, text(body?.threadId)), text(body?.item), fields);
  }

  @Post("totp")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async totp(@Req() request: any, @Body() body: JsonBody = {}) {
    vaultAgent(request);
    return agentRequestTotp(await agentThreadIdFromRequest(request, text(body?.threadId)), text(body?.item), { approvalId: text(body?.approvalId) });
  }
}
