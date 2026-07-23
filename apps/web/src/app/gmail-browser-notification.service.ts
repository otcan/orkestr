import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, GmailNotificationRule } from "./api.service";

type DeliveryCursor = Record<string, string>;

@Injectable({ providedIn: "root" })
export class GmailBrowserNotificationService {
  private readonly api = inject(ApiService);
  private readonly storageKey = "orkestr:gmail-browser-notifications:v1";
  private readonly pollIntervalMs = 30_000;
  private poller: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  start(): void {
    if (this.poller) return;
    void this.sync();
    this.poller = setInterval(() => void this.sync(), this.pollIntervalMs);
  }

  stop(): void {
    if (!this.poller) return;
    clearInterval(this.poller);
    this.poller = null;
  }

  supported(): boolean {
    return typeof globalThis.Notification !== "undefined";
  }

  permission(): NotificationPermission | "unsupported" {
    return this.supported() ? globalThis.Notification.permission : "unsupported";
  }

  async requestPermission(): Promise<NotificationPermission | "unsupported"> {
    if (!this.supported()) return "unsupported";
    return globalThis.Notification.requestPermission();
  }

  async sync(rules?: GmailNotificationRule[]): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const availableRules = rules || (await firstValueFrom(this.api.gmailNotifications())).notifications || [];
      this.process(availableRules);
    } catch {
      // Connector access can be unavailable before pairing or Gmail setup.
    } finally {
      this.syncing = false;
    }
  }

  private process(rules: GmailNotificationRule[]): void {
    const cursors = this.readCursors();
    const next: DeliveryCursor = {};
    for (const rule of rules) {
      const deliveredAt = String(rule.lastDeliveredAt || "");
      if (!deliveredAt) continue;
      next[rule.id] = deliveredAt;
      const prior = cursors[rule.id];
      if (prior && deliveredAt !== prior && this.permission() === "granted") {
        this.show(rule);
      }
    }
    this.writeCursors(next);
  }

  private show(rule: GmailNotificationRule): void {
    const destination = rule.target ? `Delivered to ${rule.target}.` : "Delivered to Orkestr.";
    const notification = new globalThis.Notification(rule.label || "New Gmail signal", {
      body: destination,
      tag: `orkestr-gmail-${rule.id}`,
    });
    notification.onclick = () => {
      globalThis.focus?.();
      if (rule.targetType === "thread" && rule.target) {
        globalThis.location.href = this.appPath(`/thread/${encodeURIComponent(rule.target)}`);
      }
      notification.close();
    };
  }

  private appPath(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
    try {
      const base = new URL(baseHref, globalThis.location?.origin || "http://localhost").pathname.replace(/\/+$/, "");
      return base && base !== "/" ? `${base}${normalized}` : normalized;
    } catch {
      return normalized;
    }
  }

  private readCursors(): DeliveryCursor {
    try {
      const parsed = JSON.parse(globalThis.localStorage?.getItem(this.storageKey) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeCursors(cursors: DeliveryCursor): void {
    try {
      globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(cursors));
    } catch {
      // Browser storage is optional; duplicate prevention still exists server-side.
    }
  }
}
