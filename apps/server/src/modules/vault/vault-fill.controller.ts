import { Body, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import { agentThreadIdFromRequest } from "../../../../../packages/core/src/vault-access.js";
import { agentFillDesktop, ownerFillDesktop } from "../../../../../packages/core/src/vault-fill.js";
import { vaultAgent, vaultOwner } from "./vault-request.js";

// Fill a vault credential into the focused field of a managed desktop
// (docs/vault.md). Responses are `{ status: "filled" | "failed" }` only.

type JsonBody = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fillInput(body: JsonBody = {}) {
  return { desktop: text(body?.desktop), field: text(body?.field), submit: body?.submit === true };
}

@Controller("api/vault")
export class VaultFillController {
  @Post("agent/fill")
  @HttpCode(200)
  async agentFill(@Req() request: any, @Body() body: JsonBody = {}) {
    vaultAgent(request);
    return agentFillDesktop(await agentThreadIdFromRequest(request, text(body?.threadId)), text(body?.item), fillInput(body));
  }

  @Post("items/:id/fill")
  @HttpCode(200)
  async ownerFill(@Req() request: any, @Param("id") id: string, @Body() body: JsonBody = {}) {
    return ownerFillDesktop(vaultOwner(request, { mutating: true }), id, fillInput(body));
  }
}
