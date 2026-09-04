import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
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
  mobileRealtimeActivationUpdate,
  mobileRealtimeCapability,
  mobileRealtimeOwnerAllowed,
} from "../../../../../packages/core/src/mobile-realtime-provider.js";
import {
  activateMobileRealtimeCall,
  claimMobileRealtimeLease,
  getMobileRealtimeCall,
  getMobileRealtimeCallInternal,
  listMobileRealtimeCallEvents,
  listMobileRealtimeCallsWithTasks,
  listPendingMobileRealtimeHangups,
  listRecoverableMobileRealtimeCalls,
  mobileRealtimeEventPollIntervalMs,
  markMobileRealtimeFinalDelivered,
  recordMobileRealtimeTranscript,
  releaseMobileRealtimeLease,
  reserveMobileRealtimeCall,
  setMobileRealtimeCallState,
  setMobileRealtimeHangupPending,
  setMobileRealtimeProviderCall,
} from "../../../../../packages/core/src/mobile-realtime-store.js";
import {
  executeMobileRealtimeTool,
  reconcileMobileRealtimeTask,
} from "../../../../../packages/core/src/mobile-realtime-tools.js";

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

class ManagedSideband {
  private socket: WebSocket | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private taskTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private activationResolve: (() => void) | null = null;
  private activationReject: ((error: Error) => void) | null = null;
  private seenProviderEvents = new Set<string>();

  constructor(
    private readonly localCallId: string,
    private readonly providerCallId: string,
    private readonly leaseOwner: string,
    private readonly onUnexpectedClose: () => void,
  ) {}

  async start(): Promise<void> {
    await claimMobileRealtimeLease(this.localCallId, this.leaseOwner, 15_000);
    const socket = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(this.providerCallId)}`,
      { headers: { authorization: `Bearer ${process.env.ORKESTR_OPENAI_API_KEY}` }, perMessageDeflate: false },
    );
    this.socket = socket;
    socket.on("message", (data) => void this.onMessage(data));
    socket.on("error", () => {
      if (this.activationReject) this.activationReject(serviceError("mobile_realtime_sideband_unavailable"));
      else if (!this.closing) socket.close();
    });
    socket.on("close", () => {
      this.activationReject?.(serviceError("mobile_realtime_sideband_unavailable"));
      if (!this.closing) this.onUnexpectedClose();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(serviceError("mobile_realtime_sideband_timeout")), 7000);
      timer.unref?.();
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(serviceError("mobile_realtime_sideband_unavailable"));
      });
    });
    let activationTimer: NodeJS.Timeout | null = null;
    const activated = new Promise<void>((resolve, reject) => {
      this.activationResolve = resolve;
      this.activationReject = reject;
      activationTimer = setTimeout(() => reject(serviceError("mobile_realtime_sideband_activation_timeout")), 7000);
      activationTimer.unref?.();
    });
    this.send(mobileRealtimeActivationUpdate());
    try {
      await activated;
    } finally {
      if (activationTimer) clearTimeout(activationTimer);
    }
    this.activationResolve = null;
    this.activationReject = null;
    this.leaseTimer = setInterval(() => {
      void claimMobileRealtimeLease(this.localCallId, this.leaseOwner, 15_000).catch(() => void this.stop());
    }, 5000);
    this.leaseTimer.unref?.();
    this.taskTimer = setInterval(() => void this.pollTask(), mobileRealtimeEventPollIntervalMs());
    this.taskTimer.unref?.();
  }

  private send(event: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw serviceError("mobile_realtime_sideband_unavailable");
    this.socket.send(JSON.stringify(event));
  }

  private async onMessage(data: WebSocket.RawData): Promise<void> {
    let event: Record<string, any>;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    const eventId = clean(event.event_id);
    if (eventId) {
      if (this.seenProviderEvents.has(eventId)) return;
      this.seenProviderEvents.add(eventId);
      if (this.seenProviderEvents.size > 1000) this.seenProviderEvents.delete(this.seenProviderEvents.values().next().value || "");
    }
    if (event.type === "session.updated") {
      this.activationResolve?.();
      return;
    }
    if (event.type === "error") {
      if (this.activationReject) this.activationReject(serviceError("mobile_realtime_sideband_configuration_failed"));
      else if (!this.closing) this.socket?.close();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      await recordMobileRealtimeTranscript(this.localCallId, {
        role: "user",
        providerItemId: event.item_id,
        text: event.transcript,
      }).catch(() => {});
      return;
    }
    if (["response.output_audio_transcript.done", "response.audio_transcript.done"].includes(event.type)) {
      await recordMobileRealtimeTranscript(this.localCallId, {
        role: "assistant",
        providerItemId: event.item_id || event.response_id,
        text: event.transcript,
      }).catch(() => {});
      return;
    }
    if (event.type !== "response.function_call_arguments.done") return;
    const output = await executeMobileRealtimeTool({
      callId: this.localCallId,
      toolCallId: clean(event.call_id),
      name: clean(event.name),
      arguments: event.arguments,
    });
    try {
      this.send({
        type: "conversation.item.create",
        event_id: `orkestr_tool_output_${randomUUID()}`,
        item: {
          type: "function_call_output",
          call_id: clean(event.call_id),
          output: JSON.stringify(output),
        },
      });
      this.send({ type: "response.create", event_id: `orkestr_tool_response_${randomUUID()}` });
    } catch {
      // Socket close handling owns recovery and prevents further tool work.
    }
  }

  private async pollTask(): Promise<void> {
    const result = await reconcileMobileRealtimeTask(this.localCallId).catch(() => null);
    if (!result) return;
    const call = await getMobileRealtimeCallInternal(this.localCallId).catch(() => null);
    if (call && result.event) await enqueueMobileRealtimePush(call, result.event).catch(() => {});
    if (result.turn?.status !== "final") {
      if (result.event && ["working", "waiting_for_approval", "failed"].includes(result.event.stage)) {
        try {
          this.send({
            type: "conversation.item.create",
            event_id: `orkestr_progress_${randomUUID()}`,
            item: {
              type: "message",
              role: "system",
              content: [{ type: "input_text", text: `Trusted Orkestr progress: ${clean(result.event.detail)}` }],
            },
          });
          this.send({
            type: "response.create",
            event_id: `orkestr_progress_response_${randomUUID()}`,
            response: { instructions: "Give the caller this Orkestr progress update in one short sentence. Do not claim completion." },
          });
        } catch {
          // Structured progress remains durable over Orkestr SSE and APNs.
        }
      }
      return;
    }
    if (call?.finalSidebandDelivered === true) return;
    try {
      this.send({
        type: "conversation.item.create",
        event_id: `orkestr_result_${randomUUID()}`,
        item: {
          type: "message",
          role: "system",
          content: [{
            type: "input_text",
            text: `Authoritative Orkestr result:\n${clean(result.turn.answer).slice(0, 50_000)}`,
          }],
        },
      });
      this.send({
        type: "response.create",
        event_id: `orkestr_result_response_${randomUUID()}`,
        response: {
          instructions: "Tell the user Orkestr finished. Give a concise faithful summary and say the complete text is in Hush.",
        },
      });
      await markMobileRealtimeFinalDelivered(this.localCallId, result.turn.id).catch(() => {});
    } catch {
      // The complete answer remains durable and replayable over Orkestr SSE.
    }
  }

  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.taskTimer) clearInterval(this.taskTimer);
    this.leaseTimer = null;
    this.taskTimer = null;
    this.socket?.close();
    this.socket = null;
    await releaseMobileRealtimeLease(this.localCallId, this.leaseOwner);
  }
}

@Injectable()
export class MobileRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly leaseOwner = `mobile-realtime:${process.pid}:${randomUUID()}`;
  private readonly controllers = new Map<string, ManagedSideband>();
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
    const controller = new ManagedSideband(call.id, call.providerCallId, this.leaseOwner, () => {
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
