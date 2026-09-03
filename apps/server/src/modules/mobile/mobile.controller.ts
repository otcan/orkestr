import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  listMobileDevices,
  listMobilePairings,
  listMobileProfiles,
  pollMobileDevicePairing,
  revokeMobileDevice,
  startMobileDevicePairing,
} from "../../../../../packages/core/src/mobile-devices.js";
import { refreshMobileDeviceSession } from "../../../../../packages/core/src/mobile-device-auth.js";

function requireOwner(request: any) {
  const principal = request?.orkestrPrincipal || null;
  if (String(principal?.role || "") !== "admin" || request?.orkestrMachineAuth) {
    const error: any = new Error("mobile_owner_required");
    error.statusCode = 403;
    throw error;
  }
  return principal;
}

@Controller("api/mobile")
export class MobileController {
  @Post("pairings/start")
  @HttpCode(200)
  async startPairingPlural(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return startMobileDevicePairing({ request, body });
  }

  @Post("pairing/start")
  @HttpCode(200)
  async startPairing(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return startMobileDevicePairing({ request, body });
  }

  @Get("pairings/:pairingId/poll")
  async pollPairingPlural(@Param("pairingId") pairingId: string, @Query("pollToken") pollToken = "") {
    return pollMobileDevicePairing(pairingId, { pollToken });
  }

  @Get("pairing/:pairingId/poll")
  async pollPairing(@Param("pairingId") pairingId: string, @Query("pollToken") pollToken = "") {
    return pollMobileDevicePairing(pairingId, { pollToken });
  }

  @Post("pairings/:pairingId/complete")
  @HttpCode(200)
  async completePairingPlural(@Param("pairingId") pairingId: string, @Body() body: Record<string, unknown> = {}) {
    return completeMobileDevicePairing(pairingId, {
      pollToken: String(body.pollToken || ""),
      challengeId: String(body.challengeId || ""),
      proof: String(body.proof || ""),
    });
  }

  @Post("pairing/:pairingId/complete")
  @HttpCode(200)
  async completePairing(@Param("pairingId") pairingId: string, @Body() body: Record<string, unknown> = {}) {
    return completeMobileDevicePairing(pairingId, {
      pollToken: String(body.pollToken || ""),
      challengeId: String(body.challengeId || ""),
      proof: String(body.proof || ""),
    });
  }

  @Post("session/refresh")
  @HttpCode(200)
  async refreshSession(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return refreshMobileDeviceSession({
      request,
      refreshToken: String(body.refreshToken || ""),
      proof: String(request?.headers?.["x-orkestr-device-proof"] || body.proof || ""),
    });
  }

  @Get("pairings")
  async ownerPairings(@Req() request: any) {
    return listMobilePairings({ principal: requireOwner(request) });
  }

  @Get("profiles")
  async ownerProfiles(@Req() request: any) {
    return listMobileProfiles({ principal: requireOwner(request) });
  }

  @Get("devices")
  async ownerDevices(@Req() request: any) {
    return listMobileDevices({ principal: requireOwner(request) });
  }

  @Post("profiles/:profileId/pairings/approve")
  @HttpCode(200)
  async ownerApproveProfilePairing(
    @Req() request: any,
    @Param("profileId") profileId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return approveMobileDevicePairing(String(body.pairingCode || ""), {
      profileId,
      principal: requireOwner(request),
    });
  }

  @Post("devices/:deviceId/revoke")
  @HttpCode(200)
  async ownerRevokeDevice(@Req() request: any, @Param("deviceId") deviceId: string) {
    return revokeMobileDevice(deviceId, { principal: requireOwner(request) });
  }

  @Get("owner/pairings")
  async ownerPairingsLegacy(@Req() request: any) {
    requireOwner(request);
    return listMobilePairings();
  }

  @Post("owner/pairings/:pairingId/approve")
  @HttpCode(200)
  async ownerApprovePairingLegacy(
    @Req() request: any,
    @Param("pairingId") pairingId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return approveMobileDevicePairing(pairingId, {
      profileId: String(body.profileId || ""),
      principal: requireOwner(request),
    });
  }
}
