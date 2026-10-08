import { Body, Controller, Get, Header, HttpCode, Post, Query, Req } from "@nestjs/common";
import { agentListItems, agentReadSecret, agentRequestTotp } from "../../../../../packages/core/src/vault-agent.js";
import { SECURE_RESPONSE_HEADER, vaultAgent } from "./vault-request.js";

// Agent API used only by `orkestr vault` (local CLI machine credential). The
// thread id selects which grants apply; the vault is the thread owner's.

type JsonBody = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

@Controller("api/vault/agent")
export class VaultAgentController {
  @Get("items")
  async list(@Req() request: any, @Query() query: JsonBody = {}) {
    vaultAgent(request);
    return agentListItems(text(query.threadId));
  }

  @Post("credentials")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async credentials(@Req() request: any, @Body() body: JsonBody = {}) {
    vaultAgent(request);
    const fields = Array.isArray(body?.fields) ? body.fields.map(text) : ["username", "password"];
    return agentReadSecret(text(body?.threadId), text(body?.item), fields);
  }

  @Post("totp")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async totp(@Req() request: any, @Body() body: JsonBody = {}) {
    vaultAgent(request);
    return agentRequestTotp(text(body?.threadId), text(body?.item), { approvalId: text(body?.approvalId) });
  }
}
