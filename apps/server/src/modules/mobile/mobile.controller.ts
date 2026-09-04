import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import {
  approveMobileDevicePairing,
  completeMobileDevicePairing,
  listMobileDevices,
  listOwnerMobileProfiles,
  pollMobileDevicePairing,
  refreshMobileDeviceSession,
  revokeMobileDevice,
  startMobileDevicePairing,
} from "../../../../../packages/core/src/mobile-devices.js";
import {
  mobileDeviceParamsSchema,
  mobilePairingApprovalSchema,
  mobilePairingCompleteSchema,
  mobilePairingPollSchema,
  mobilePairingStartSchema,
  mobileSessionRefreshSchema,
} from "../../../../../packages/shared/src/api-schemas.js";
import { validateRequestSchema } from "../../common/http.js";
import { MobileRealtimeService } from "../mobile-realtime/mobile-realtime.service.js";

function requireOwner(request: any) {
  const principal = request?.orkestrPrincipal || null;
  if (!String(principal?.userId || "").trim() || request?.orkestrMachineAuth) {
    const error: any = new Error("mobile_owner_required");
    error.statusCode = 403;
    throw error;
  }
  return principal;
}

@Controller("api/mobile")
export class MobileController {
  constructor(private readonly mobileRealtime: MobileRealtimeService) {}

  @Post("pairing/start")
  @HttpCode(200)
  async startPairing(
    @Req() request: any,
    @Res({ passthrough: true }) response: any,
    @Body() body: Record<string, unknown> = {},
  ) {
    validateRequestSchema(mobilePairingStartSchema, { body });
    try {
      return await startMobileDevicePairing({ request, body });
    } catch (error: any) {
      if (Number(error?.statusCode) === 429 && Number(error?.retryAfterSeconds) > 0) {
        response.setHeader("retry-after", String(Math.ceil(error.retryAfterSeconds)));
      }
      throw error;
    }
  }

  @Get("pairing/:pairingId/poll")
  async pollPairing(@Param("pairingId") pairingId: string, @Query("pollToken") pollToken = "") {
    validateRequestSchema(mobilePairingPollSchema, { params: { pairingId }, querystring: { pollToken } });
    return pollMobileDevicePairing(pairingId, { pollToken });
  }

  @Post("pairing/:pairingId/complete")
  @HttpCode(200)
  async completePairing(@Param("pairingId") pairingId: string, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(mobilePairingCompleteSchema, { params: { pairingId }, body });
    return completeMobileDevicePairing(pairingId, {
      pollToken: String(body.pollToken || ""),
      challengeId: String(body.challengeId || ""),
      proof: String(body.proof || ""),
    });
  }

  @Post("session/refresh")
  @HttpCode(200)
  async refreshSession(@Req() request: any, @Body() body: Record<string, unknown> = {}) {
    validateRequestSchema(mobileSessionRefreshSchema, { body });
    return refreshMobileDeviceSession({
      request,
      refreshToken: String(body.refreshToken || ""),
      proof: String(request?.headers?.["x-orkestr-device-proof"] || ""),
    });
  }

  @Get("profiles")
  async ownerProfiles(@Req() request: any) {
    return listOwnerMobileProfiles({ principal: requireOwner(request) });
  }

  @Post("profiles/:profileId/pairings/approve")
  @HttpCode(200)
  async ownerApprovePairing(
    @Req() request: any,
    @Param("profileId") profileId: string,
    @Body() body: Record<string, unknown> = {},
  ) {
    validateRequestSchema(mobilePairingApprovalSchema, { params: { profileId }, body });
    return approveMobileDevicePairing(String(body.pairingCode || ""), {
      profileId,
      principal: requireOwner(request),
    });
  }

  @Get("devices")
  async ownerDevices(@Req() request: any) {
    return listMobileDevices({ principal: requireOwner(request) });
  }

  @Post("devices/:deviceId/revoke")
  @HttpCode(200)
  async ownerRevokeDevice(@Req() request: any, @Param("deviceId") deviceId: string) {
    validateRequestSchema(mobileDeviceParamsSchema, { params: { deviceId } });
    const revoked = await revokeMobileDevice(deviceId, { principal: requireOwner(request) });
    // Device/session revocation is already durable at this point. Provider and
    // notification cleanup is best effort and must not delay the security result.
    void this.mobileRealtime.revokeDevice(deviceId).catch(() => {});
    return revoked;
  }
}
