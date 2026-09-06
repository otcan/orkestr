import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { enqueueMobileRealtimePush } from "../../../../../packages/core/src/mobile-push.js";
import { syncMobileRealtimeThreadMirror } from "../../../../../packages/core/src/mobile-realtime-mirror.js";
import { mobileRealtimeActivationUpdate } from "../../../../../packages/core/src/mobile-realtime-provider.js";
import {
  claimMobileRealtimeLease,
  getMobileRealtimeCallInternal,
  mobileRealtimeEventPollIntervalMs,
  recordMobileRealtimeTranscript,
  releaseMobileRealtimeLease,
} from "../../../../../packages/core/src/mobile-realtime-store.js";
import { reconcileMobileRealtimeTask } from "../../../../../packages/core/src/mobile-realtime-tools.js";
import { submitMobileRealtimeTurn } from "../../../../../packages/core/src/mobile-realtime-turns.js";

function clean(value: unknown): string {
  return String(value || "").trim();
}

function serviceError(code: string): Error & { statusCode: number; code: string } {
  const error = new Error(code) as Error & { statusCode: number; code: string };
  error.statusCode = 503;
  error.code = code;
  return error;
}

export class ManagedMobileRealtimeSideband {
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
      const automaticResponses = event?.session?.audio?.input?.turn_detection?.create_response;
      const configuredTools = event?.session?.tools;
      if (automaticResponses === true || (Array.isArray(configuredTools) && configuredTools.length > 0)) {
        this.send(mobileRealtimeActivationUpdate());
        return;
      }
      this.activationResolve?.();
      return;
    }
    if (event.type === "error") {
      if (this.activationReject) this.activationReject(serviceError("mobile_realtime_sideband_configuration_failed"));
      else if (!this.closing) this.socket?.close();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      await this.onCompletedUserTranscript(event);
      return;
    }
    if (event.type === "response.created") {
      this.authorizeProviderResponse(event);
      return;
    }
    if (event.type === "response.function_call_arguments.done") this.rejectProviderTool(event);
  }

  private async onCompletedUserTranscript(event: Record<string, any>): Promise<void> {
    const recorded = await recordMobileRealtimeTranscript(this.localCallId, {
      role: "user",
      providerItemId: event.item_id,
      text: event.transcript,
    }).catch(() => null);
    const text = clean(event.transcript);
    if (!text || !clean(event.item_id) || recorded === null) return;
    await submitMobileRealtimeTurn({
      callId: this.localCallId,
      sourceKind: "provider_audio",
      sourceId: clean(event.item_id),
      text,
      locale: clean(event.language) || "und",
    }).catch(() => {});
  }

  private authorizeProviderResponse(event: Record<string, any>): void {
    try {
      this.send({
        type: "response.cancel",
        event_id: `orkestr_cancel_untrusted_${randomUUID()}`,
        ...(clean(event?.response?.id) ? { response_id: clean(event.response.id) } : {}),
      });
    } catch {
      // Socket recovery owns any transport failure.
    }
  }

  private rejectProviderTool(event: Record<string, any>): void {
    try {
      this.send({
        type: "conversation.item.create",
        event_id: `orkestr_reject_tool_${randomUUID()}`,
        item: {
          type: "function_call_output",
          call_id: clean(event.call_id),
          output: JSON.stringify({ ok: false, error: { code: "mobile_realtime_tool_not_allowed", retryable: false } }),
        },
      });
    } catch {
      // Socket close handling owns recovery and prevents further tool work.
    }
  }

  private async pollTask(): Promise<void> {
    if (this.closing) return;
    await syncMobileRealtimeThreadMirror(this.localCallId).catch(() => []);
    const result = await reconcileMobileRealtimeTask(this.localCallId).catch(() => null);
    if (!result) return;
    const call = await getMobileRealtimeCallInternal(this.localCallId).catch(() => null);
    if (call && result.event) await enqueueMobileRealtimePush(call, result.event).catch(() => {});
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
