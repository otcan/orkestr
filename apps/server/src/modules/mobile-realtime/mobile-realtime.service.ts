import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { mobileDeviceContextIsActive } from "../../../../../packages/core/src/mobile-devices.js";
import {
  enqueueMobileRealtimePush,
  notifyMobileDeviceRevoked,
  processMobilePushOutbox,
  removeMobilePushTokensForDevice,
  upsertMobileLiveActivityToken,
  upsertMobilePushToken,
} from "../../../../../packages/core/src/mobile-push.js";
import {
  createOpenAIRealtimeCall,
  hangupOpenAIRealtimeCall,
  mobileRealtimeCapability,
  mobileRealtimeOwnerAllowed,
} from "../../../../../packages/core/src/mobile-realtime-provider.js";
import {
  activateMobileRealtimeCall,
  getMobileRealtimeCall,
  getMobileRealtimeCallInternal,
  listMobileRealtimeCallEvents,
  listMobileRealtimeCallsWithTasks,
  listPendingMobileRealtimeHangups,
  listRecoverableMobileRealtimeCalls,
  mobileRealtimeEventPollIntervalMs,
  reserveMobileRealtimeCall,
  setMobileRealtimeCallState,
  setMobileRealtimeHangupPending,
  setMobileRealtimeProviderCall,
} from "../../../../../packages/core/src/mobile-realtime-store.js";
import { reconcileMobileRealtimeTask } from "../../../../../packages/core/src/mobile-realtime-tools.js";
import { submitMobileRealtimeTurn } from "../../../../../packages/core/src/mobile-realtime-turns.js";
import { ManagedMobileRealtimeSideband } from "./mobile-realtime-sideband.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function serviceError(code: string, statusCode = 503): Error & { statusCode: number; code: string } {
  const error = new Error(code) as Error & { statusCode: number; code: string };
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

@Injectable()
export class MobileRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly leaseOwner = `mobile-realtime:${process.pid}:${randomUUID()}`;
  private readonly controllers = new Map<string, ManagedMobileRealtimeSideband>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepRunning = false;
  private shuttingDown = false;

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), 5000);
    this.sweepTimer.unref?.();
    void this.recover();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const calls = await listRecoverableMobileRealtimeCalls().catch(() => []);
    await Promise.all(calls.map((call) => this.endInternal(call.id, "server_shutdown")));
  }

  capability(input: Record<string, any>): Record<string, unknown> {
    const capability = mobileRealtimeCapability();
    if (capability.enabled && !mobileRealtimeOwnerAllowed(input?.device?.ownerUserId)) {
      return { enabled: false, reason: "owner_not_enabled" };
    }
    return capability;
  }

  async create(input: Record<string, any>): Promise<Record<string, unknown>> {
    if (!mobileRealtimeCapability().enabled) throw serviceError("mobile_realtime_unavailable");
    if (!mobileRealtimeOwnerAllowed(input?.device?.ownerUserId)) {
      throw serviceError("mobile_realtime_owner_not_enabled", 403);
    }
    const reserved = await reserveMobileRealtimeCall(input);
    if (!reserved.created) {
      await this.ensureController(reserved.call);
      if (["connecting", "reconnecting"].includes(clean(reserved.call.status))) {
        return activateMobileRealtimeCall(reserved.call.id);
      }
      return reserved.response;
    }
    let providerCallId = "";
    try {
      const provider = await createOpenAIRealtimeCall({
        offerSdp: input.offerSdp,
        ownerUserId: reserved.call.ownerUserId,
      });
      providerCallId = provider.providerCallId;
      const call = await setMobileRealtimeProviderCall(reserved.call.id, provider);
      await this.ensureController(call);
      return await activateMobileRealtimeCall(call.id);
    } catch (error: any) {
      const controller = this.controllers.get(reserved.call.id);
      this.controllers.delete(reserved.call.id);
      await controller?.stop();
      if (providerCallId) {
        const hangup = await hangupOpenAIRealtimeCall(providerCallId);
        await setMobileRealtimeHangupPending(reserved.call.id, !hangup.ok);
      }
      await setMobileRealtimeCallState(reserved.call.id, "failed", "provider_or_sideband_unavailable").catch(() => {});
      throw serviceError(clean(error?.code) || "mobile_realtime_provider_unavailable", Number(error?.statusCode || 503));
    }
  }

  get(callId: string, input: Record<string, unknown>) {
    return getMobileRealtimeCall(callId, input);
  }

  events(callId: string, afterEventId: number, input: Record<string, unknown>) {
    return listMobileRealtimeCallEvents(callId, afterEventId, input);
  }

  submitTurn(callId: string, input: Record<string, unknown>) {
    return submitMobileRealtimeTurn({ callId, sourceKind: "typed", sourceId: input.clientTurnId, ...input });
  }

  async end(callId: string, input: Record<string, any>) {
    const visible = await getMobileRealtimeCall(callId, input);
    if (["ended", "failed"].includes(clean((visible as any).status))) return visible;
    await this.endInternal(callId, "client_hangup");
    return getMobileRealtimeCall(callId, input);
  }

  pushToken(input: Record<string, unknown>) {
    return upsertMobilePushToken(input);
  }

  liveActivityToken(input: Record<string, unknown>) {
    return upsertMobileLiveActivityToken(input);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const calls = await listRecoverableMobileRealtimeCalls().catch(() => []);
    await Promise.all(calls.filter((call) => call.deviceId === deviceId).map((call) => this.endInternal(call.id, "device_revoked")));
    await notifyMobileDeviceRevoked(deviceId).catch(() => {});
    await removeMobilePushTokensForDevice(deviceId).catch(() => {});
  }

  deviceActive(device: Record<string, unknown>) {
    return mobileDeviceContextIsActive(device);
  }

  pollIntervalMs(): number {
    return mobileRealtimeEventPollIntervalMs();
  }

  private async ensureController(call: Record<string, any>): Promise<void> {
    if (this.controllers.has(call.id)) return;
    if (!clean(call.providerCallId)) throw serviceError("mobile_realtime_call_not_ready", 409);
    const controller = new ManagedMobileRealtimeSideband(call.id, call.providerCallId, this.leaseOwner, () => {
      this.controllers.delete(call.id);
      void setMobileRealtimeCallState(call.id, "reconnecting", "sideband_disconnected")
        .then(() => this.reconnect(call.id, Date.now() + 10_000))
        .catch(() => {});
    });
    this.controllers.set(call.id, controller);
    try {
      await controller.start();
    } catch (error) {
      this.controllers.delete(call.id);
      await controller.stop();
      throw error;
    }
  }

  private async reconnect(callId: string, deadline: number): Promise<void> {
    if (this.shuttingDown || this.controllers.has(callId)) return;
    const call = await getMobileRealtimeCallInternal(callId).catch(() => null);
    if (!call || !["connecting", "active", "reconnecting"].includes(clean(call.status))) return;
    while (!this.shuttingDown && Date.now() < deadline) {
      try {
        await this.ensureController(call);
        await activateMobileRealtimeCall(callId).catch(() => {});
        return;
      } catch {
        await delay(750);
      }
    }
    await this.endInternal(callId, "sideband_reconnect_failed");
  }

  private async endInternal(callId: string, reason: string): Promise<void> {
    const call = await getMobileRealtimeCallInternal(callId).catch(() => null);
    if (!call || ["ended", "failed"].includes(clean(call.status))) return;
    await setMobileRealtimeCallState(callId, "ending", reason).catch(() => {});
    const controller = this.controllers.get(callId);
    this.controllers.delete(callId);
    await controller?.stop();
    const hangup = await hangupOpenAIRealtimeCall(call.providerCallId);
    await setMobileRealtimeHangupPending(callId, !hangup.ok);
    await setMobileRealtimeCallState(callId, "ended", reason).catch(() => {});
  }

  private async recover(): Promise<void> {
    if (!mobileRealtimeCapability().enabled) return;
    const calls = await listRecoverableMobileRealtimeCalls().catch(() => []);
    for (const call of calls) {
      if (clean(call.status) === "ending" || Date.parse(call.expiresAt || "") <= Date.now() ||
          !(await mobileDeviceContextIsActive(call).catch(() => false))) {
        await this.endInternal(call.id, "expired_or_revoked");
        continue;
      }
      void this.reconnect(call.id, Date.now() + 10_000);
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      const calls = await listRecoverableMobileRealtimeCalls().catch(() => []);
      for (const call of calls) {
        const active = Date.parse(call.expiresAt || "") > Date.now() && await mobileDeviceContextIsActive(call).catch(() => false);
        if (!active) await this.endInternal(call.id, "expired_or_revoked");
      }
      const pendingHangups = await listPendingMobileRealtimeHangups().catch(() => []);
      for (const call of pendingHangups) {
        const hangup = await hangupOpenAIRealtimeCall(call.providerCallId);
        if (hangup.ok) await setMobileRealtimeHangupPending(call.id, false);
      }
      const tasks = await listMobileRealtimeCallsWithTasks().catch(() => []);
      for (const call of tasks) {
        if (this.controllers.has(call.id)) continue;
        const result = await reconcileMobileRealtimeTask(call.id).catch(() => null);
        if (result?.event) await enqueueMobileRealtimePush(call, result.event).catch(() => {});
      }
      await processMobilePushOutbox().catch(() => {});
    } finally {
      this.sweepRunning = false;
    }
  }
}
