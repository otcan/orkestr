import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  listMobileDevices,
  listMobilePairings,
  listMobileProfiles,
  pollMobileDevicePairing,
  refreshMobileDeviceSession,
  revokeMobileDevice,
  startMobileDevicePairing,
} from "../../../../../packages/core/src/mobile-devices.js";

function requireOwner(request: any) {
  const principal = request?.orkestrPrincipal || null;
  if (String(principal?.role || "") !== "admin" || request?.orkestrMachineAuth === "mobile_device") {
    const error: any = new Error("mobile_owner_required");
    error.statusCode = 403;
    throw error;
  }
  return principal;
}

@Controller("api/mobile")
export class MobileController {
  @Post("pairing/start")
  @HttpCode(200)
  async startPairing(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    return startMobileDevicePairing({ request, body });
  }

  @Get("pairing/:pairingId/poll")
  async pollPairing(@Param("pairingId") pairingId: string, @Query("pollToken") pollToken = "") {
    return pollMobileDevicePairing(pairingId, { pollToken });
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

  @Get("owner/profiles")
  async ownerProfiles(@Req() request: any) {
    requireOwner(request);
    return listMobileProfiles();
  }

  @Get("owner/pairings")
  async ownerPairings(@Req() request: any) {
    requireOwner(request);
    return listMobilePairings();
  }

  @Post("owner/pairings/:pairingId/approve")
  @HttpCode(200)
  async ownerApprovePairing(
    @Req() request: any,
    @Param("pairingId") pairingId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    return approveMobileDevicePairing(pairingId, {
      profileId: String(body.profileId || ""),
      principal: requireOwner(request),
    });
  }

  @Get("owner/devices")
  async ownerDevices(@Req() request: any) {
    requireOwner(request);
    return listMobileDevices();
  }

  @Post("owner/devices/:deviceId/revoke")
  @HttpCode(200)
  async ownerRevokeDevice(@Req() request: any, @Param("deviceId") deviceId: string) {
    return revokeMobileDevice(deviceId, { principal: requireOwner(request) });
  }
}
