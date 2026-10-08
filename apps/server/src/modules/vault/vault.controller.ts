import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { decideVaultApproval, listVaultApprovals } from "../../../../../packages/core/src/vault-agent.js";
import {
  createVaultItem,
  deleteVaultItem,
  exportTotpSecret,
  importVault,
  listVaultItems,
  ownerTotpCode,
  revealVaultItem,
  setVaultGrants,
  updateVaultItem,
  vaultStatus,
} from "../../../../../packages/core/src/vault-service.js";
import { SECURE_RESPONSE_HEADER, vaultOwner } from "./vault-request.js";

// Owner API for the password manager / authenticator (docs/vault.md).
// Responses never include secret values except reveal, totp and totp-secret.

type JsonBody = Record<string, unknown>;

@Controller("api/vault")
export class VaultController {
  @Get("status")
  async status(@Req() request: any, @Query() query: JsonBody = {}) {
    return vaultStatus(vaultOwner(request), query);
  }

  @Get("items")
  async list(@Req() request: any) {
    return listVaultItems(vaultOwner(request));
  }

  @Post("items")
  @HttpCode(201)
  async create(@Req() request: any, @Body() body: JsonBody = {}) {
    return createVaultItem(vaultOwner(request, { mutating: true }), body || {});
  }

  @Patch("items/:id")
  async update(@Req() request: any, @Param("id") id: string, @Body() body: JsonBody = {}) {
    return updateVaultItem(vaultOwner(request, { mutating: true }), id, body || {});
  }

  @Delete("items/:id")
  async remove(@Req() request: any, @Param("id") id: string) {
    return deleteVaultItem(vaultOwner(request, { mutating: true }), id);
  }

  @Post("items/:id/reveal")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async reveal(@Req() request: any, @Param("id") id: string) {
    return revealVaultItem(vaultOwner(request, { mutating: true }), id);
  }

  @Get("items/:id/totp")
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async totp(@Req() request: any, @Param("id") id: string) {
    return ownerTotpCode(vaultOwner(request), id);
  }

  @Post("items/:id/totp-secret")
  @HttpCode(200)
  @Header("X-Orkestr-Secure-Input", SECURE_RESPONSE_HEADER)
  async totpSecret(@Req() request: any, @Param("id") id: string) {
    return exportTotpSecret(vaultOwner(request, { mutating: true }), id);
  }

  @Put("items/:id/grants")
  async grants(@Req() request: any, @Param("id") id: string, @Body() body: JsonBody = {}) {
    return setVaultGrants(vaultOwner(request, { mutating: true }), id, (body || {}).threadIds);
  }

  @Post("import")
  @HttpCode(200)
  async import(@Req() request: any, @Body() body: JsonBody = {}) {
    return importVault(vaultOwner(request, { mutating: true }), body || {});
  }

  @Get("approvals")
  async approvals(@Req() request: any) {
    return listVaultApprovals(vaultOwner(request));
  }

  @Post("approvals/:id/approve")
  @HttpCode(200)
  async approve(@Req() request: any, @Param("id") id: string) {
    return decideVaultApproval(vaultOwner(request, { mutating: true }), id, "approve");
  }

  @Post("approvals/:id/deny")
  @HttpCode(200)
  async deny(@Req() request: any, @Param("id") id: string) {
    return decideVaultApproval(vaultOwner(request, { mutating: true }), id, "deny");
  }
}
