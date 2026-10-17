import { HttpClient } from "@angular/common/http";
import { Component, EventEmitter, OnDestroy, OnInit, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, BrowserSession } from "./api.service";
import { isVaultReauthRequired, vaultErrorMessage } from "./vault-secrets";

// Password-blind Chrome password handoff (docs/password-handoff.md). The owner
// opens it for one tab, lets Chrome suggest and save a password in the live
// desktop, then ends it. Agents are locked out of the desktop meanwhile.
// This page only ever sees ids, origins and status words.

export interface PasswordHandoff {
  id: string;
  desktopSlug: string;
  threadId: string;
  origin: string;
  state: string;
  expiresAt: string;
  status?: string;
  reason?: string;
  expired?: boolean;
  chromeFilled?: boolean;
  saveCheck?: string;
}

interface HandoffTargets {
  desktopSlug: string;
  threadId: string;
  tabs: { targetId: string; origin: string }[];
}

const pollMs = 5_000;

function apiBase(): string {
  const baseHref = globalThis.document?.querySelector("base")?.getAttribute("href") || "/";
  return `${baseHref.endsWith("/") ? baseHref.slice(0, -1) : baseHref}/api/vault/password-handoffs`;
}

export function handoffStatusText(handoff: PasswordHandoff): string {
  const status = handoff.status || "";
  if (status === "awaiting_owner") return "Waiting for you: in the desktop, click the password field and choose Chrome's suggested password.";
  if (status === "accepted") return "Password filled. Not saved yet. In Chrome, confirm saving it before you end the handoff.";
  if (status === "saved_verified") return "Saved in Chrome for this site. You can end the handoff.";
  if (handoff.reason === "ambiguous_tab") return "Status unknown: another tab has the same site open. Close it so the save can be checked.";
  if (handoff.reason === "origin_mismatch") return "Status unknown: the tab left this site.";
  if (handoff.reason === "tab_not_found") return "Status unknown: the tab was closed.";
  if (handoff.saveCheck === "journal_pending") return "Filled; Chrome is still writing its login store. Check again in a moment.";
  return status ? `Status unknown${handoff.reason ? ` (${handoff.reason})` : ""}.` : "Checking…";
}

@Component({
  selector: "ork-password-handoff-panel",
  imports: [FormsModule],
  template: `
    @for (handoff of handoffs; track handoff.id) {
      <div class="vault-approval" role="status">
        <p><strong>Password handoff</strong> on <strong>{{ handoff.desktopSlug }}</strong> for <strong>{{ handoff.origin }}</strong>.
          Agents are locked out of this desktop until you end it{{ handoff.expired ? " (time is up, so please end it)" : "" }}.</p>
        <p>{{ statusText(handoff) }}</p>
        <div class="vault-approval-actions">
          <button class="secondary" type="button" (click)="openDesktop(handoff)" [disabled]="busyId === handoff.id">Open desktop</button>
          <button type="button" (click)="end(handoff, 'owner_ended')" [disabled]="busyId === handoff.id">Done</button>
          <button class="secondary" type="button" (click)="end(handoff, 'signup_abandoned')" [disabled]="busyId === handoff.id">Cancel</button>
        </div>
      </div>
    }
    @if (!starting) {
      <button class="secondary" type="button" (click)="openStart()">New site password with Chrome…</button>
    } @else {
      <div class="vault-approval">
        <p><strong>New site password with Chrome.</strong> Chrome generates and saves the password; Orkestr and agents never see it.</p>
        <label>Desktop
          <select [(ngModel)]="desktop" (ngModelChange)="loadTargets()">
            @for (session of desktops; track slug(session)) {
              <option [value]="slug(session)">{{ slug(session) }}</option>
            }
          </select>
        </label>
        @if (targets) {
          @if (!targets.threadId) {
            <p class="vault-notice warn">No thread holds this desktop. A thread must lease it first.</p>
          } @else if (!targets.tabs.length) {
            <p class="vault-notice warn">No https tab is open on this desktop.</p>
          } @else {
            <p>Thread <strong>{{ targets.threadId }}</strong> holds this desktop.</p>
            <label>Signup tab
              <select [(ngModel)]="targetId">
                @for (tab of targets.tabs; track tab.targetId) {
                  <option [value]="tab.targetId">{{ tab.origin }}</option>
                }
              </select>
            </label>
          }
        }
        <div class="vault-approval-actions">
          <button type="button" (click)="start()" [disabled]="busy || !targetId || !targets?.threadId">Lock agents out and start</button>
          <button class="secondary" type="button" (click)="starting = false">Close</button>
        </div>
      </div>
    }
    @if (error) {
      <p class="vault-notice error" role="alert">{{ error }}</p>
    }
  `,
})
export class PasswordHandoffPanelComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly desktopsApi = inject(ApiService);
  @Output() readonly reauth = new EventEmitter<void>();
  handoffs: PasswordHandoff[] = [];
  desktops: BrowserSession[] = [];
  desktop = "";
  targets: HandoffTargets | null = null;
  targetId = "";
  starting = false;
  busy = false;
  busyId = "";
  error = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.load();
    this.timer = setInterval(() => void this.load(), pollMs);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  slug(session: BrowserSession): string {
    return String(session.slug || session.id || "");
  }

  statusText(handoff: PasswordHandoff): string {
    return handoffStatusText(handoff);
  }

  desktopUrl(slug: string): string {
    const encoded = encodeURIComponent(slug);
    return `/desktop/${encoded}/vnc.html?autoconnect=1&resize=scale&view_only=false&path=desktop/${encoded}/websockify`;
  }

  // A desktop share opened for this browser session works where desktops
  // require brokered shares and counts as the owner during the handoff.
  // Sessions that cannot open such a share use the direct desktop link.
  async openDesktop(handoff: PasswordHandoff): Promise<void> {
    const pending = window.open("about:blank", "_blank");
    try {
      if (pending) pending.opener = null;
    } catch {
      // Some browsers block assigning opener on a new tab.
    }
    let url = "";
    try {
      url = (await firstValueFrom(this.desktopsApi.openDesktopSession(handoff.desktopSlug, { threadId: handoff.threadId, start: false })))?.url || "";
    } catch {
      url = "";
    }
    url ||= this.desktopUrl(handoff.desktopSlug);
    if (pending) pending.location.href = url;
    else window.location.assign(url);
  }

  async load(): Promise<void> {
    try {
      const open = (await firstValueFrom(this.http.get<{ handoffs: PasswordHandoff[] }>(apiBase())))?.handoffs || [];
      // Only open handoffs are probed, one status call each.
      this.handoffs = await Promise.all(open.map((item) =>
        firstValueFrom(this.http.get<PasswordHandoff>(`${apiBase()}/${encodeURIComponent(item.id)}`)).catch(() => item)));
    } catch {
      // The vault page reports session problems; keep the last view.
    }
  }

  async openStart(): Promise<void> {
    this.starting = true;
    this.error = "";
    try {
      const result = await firstValueFrom(this.desktopsApi.browserSessions());
      this.desktops = (result?.sessions || result?.browsers || []).filter((session) => this.slug(session));
      this.desktop = this.slug(this.desktops[0] || {});
      await this.loadTargets();
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not load desktops.");
    }
  }

  async loadTargets(): Promise<void> {
    this.targets = null;
    this.targetId = "";
    if (!this.desktop) return;
    try {
      this.targets = await firstValueFrom(this.http.get<HandoffTargets>(`${apiBase()}/targets`, { params: { desktop: this.desktop } }));
      this.targetId = this.targets?.tabs?.[0]?.targetId || "";
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not read the desktop's tabs.");
    }
  }

  async start(): Promise<void> {
    const tab = this.targets?.tabs.find((item) => item.targetId === this.targetId);
    if (!tab || !this.targets?.threadId) return;
    this.busy = true;
    this.error = "";
    try {
      await firstValueFrom(this.http.post<PasswordHandoff>(apiBase(), {
        desktop: this.desktop, threadId: this.targets.threadId, targetId: tab.targetId, origin: tab.origin,
      }));
      this.starting = false;
      await this.load();
    } catch (error) {
      if (isVaultReauthRequired(error)) this.reauth.emit();
      else this.error = vaultErrorMessage(error, "Could not start the handoff.");
    } finally {
      this.busy = false;
    }
  }

  async end(handoff: PasswordHandoff, reason: "owner_ended" | "signup_abandoned"): Promise<void> {
    this.busyId = handoff.id;
    this.error = "";
    try {
      await firstValueFrom(this.http.post(`${apiBase()}/${encodeURIComponent(handoff.id)}/end`, { reason }));
      await this.load();
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not end the handoff.");
    } finally {
      this.busyId = "";
    }
  }
}
