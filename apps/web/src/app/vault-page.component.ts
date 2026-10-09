import { Component, Input, OnDestroy, OnInit, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type { ThreadSummary } from "./api.service";
import { VaultApiService, VaultApproval, VaultItem, VaultItemInput, VaultStatus } from "./vault-api.service";
import { VaultFillDialogComponent } from "./vault-fill-dialog.component";
import { VaultGrantsDialogComponent } from "./vault-grants-dialog.component";
import { VaultImportDialogComponent } from "./vault-import-dialog.component";
import { VaultItemFormComponent } from "./vault-item-form.component";
import { VaultRequestsPanelComponent } from "./vault-requests-panel.component";
import { copySecret, isVaultReauthRequired, vaultErrorMessage, vaultReauthUrl, vaultSecretTtlMs } from "./vault-secrets";
import { VaultTotpTracker, formatTotpCode } from "./vault-totp-tracker";
import { VaultVisibleDirective } from "./vault-visible.directive";

const approvalPollMs = 10_000;
const tickMs = 1_000;

interface RevealedSecret {
  itemId: string;
  label: string;
  value: string;
  notes?: string;
}

@Component({
  selector: "ork-vault-page",
  imports: [VaultFillDialogComponent, VaultGrantsDialogComponent, VaultImportDialogComponent, VaultItemFormComponent, VaultRequestsPanelComponent, VaultVisibleDirective],
  templateUrl: "./vault-page.component.html",
  styleUrl: "./vault-page.component.css",
})
export class VaultPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(VaultApiService);
  @Input() threads: ThreadSummary[] = [];

  items: VaultItem[] = [];
  status: VaultStatus | null = null;
  approvals: VaultApproval[] = [];
  loading = false;
  loaded = false;
  error = "";
  notice = "";
  query = "";
  menuId = "";
  confirmDeleteId = "";
  busyId = "";
  reauthNeeded = false;
  revealed: RevealedSecret | null = null;
  editing: VaultItem | "new" | null = null;
  formBusy = false;
  formError = "";
  importOpen = false;
  grantsItem: VaultItem | null = null;
  fillItem: VaultItem | null = null;
  readonly visibleIds = new Set<string>();
  readonly totp = new VaultTotpTracker((id) => firstValueFrom(this.api.totp(id)));
  readonly formatCode = formatTotpCode;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private approvalTimer: ReturnType<typeof setInterval> | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onVisibility = () => this.handleVisibilityChange();
  private readonly onPageHide = () => this.clearRevealed();

  ngOnInit(): void {
    void this.load();
    void this.loadApprovals();
    this.tickTimer = setInterval(() => void this.tick(), tickMs);
    this.approvalTimer = setInterval(() => { if (this.pageVisible()) void this.loadApprovals(); }, approvalPollMs);
    globalThis.document?.addEventListener("visibilitychange", this.onVisibility);
    globalThis.addEventListener?.("pagehide", this.onPageHide);
  }

  ngOnDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    globalThis.document?.removeEventListener("visibilitychange", this.onVisibility);
    globalThis.removeEventListener?.("pagehide", this.onPageHide);
    this.clearRevealed();
    this.totp.clear();
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      const [list, status] = await Promise.all([firstValueFrom(this.api.items()), firstValueFrom(this.api.status()).catch(() => null)]);
      this.items = Array.isArray(list?.items) ? list.items : [];
      this.status = status;
      this.loaded = true;
    } catch (error) {
      this.error = vaultErrorMessage(error, "Vault is unavailable.");
    } finally {
      this.loading = false;
    }
    void this.tick();
  }

  async loadApprovals(): Promise<void> {
    try {
      const result = await firstValueFrom(this.api.approvals());
      this.approvals = (result?.approvals || []).filter((approval) => !approval.status || approval.status === "pending");
    } catch {
      // Keep the last known list; the next poll retries.
    }
  }

  async decide(approval: VaultApproval, decision: "approve" | "deny"): Promise<void> {
    this.busyId = approval.id;
    try {
      await firstValueFrom(this.api.decideApproval(approval.id, decision));
      this.approvals = this.approvals.filter((entry) => entry.id !== approval.id);
      this.flash(decision === "approve" ? `Approved code for ${approval.threadName}.` : "Request denied.");
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not update the request.");
    } finally {
      this.busyId = "";
    }
    void this.loadApprovals();
  }

  filteredItems(): VaultItem[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.items;
    return this.items.filter((item) => [item.name, item.domain, item.url, item.username, ...(item.tags || [])]
      .some((value) => String(value || "").toLowerCase().includes(query)));
  }

  avatarLetter(item: VaultItem): string {
    return (String(item.name || item.domain || "?").trim()[0] || "?").toUpperCase();
  }

  setRowVisible(item: VaultItem, visible: boolean): void {
    if (visible) this.visibleIds.add(item.id);
    else this.visibleIds.delete(item.id);
    if (visible && this.autoCode(item)) void this.tick();
  }

  visibleTotpIds(): string[] {
    return this.items.filter((item) => this.autoCode(item) && this.visibleIds.has(item.id)).map((item) => item.id);
  }

  // Time-based codes refresh on their own; a counter-based (HOTP) code is
  // used up when issued, so it is only fetched when the owner asks for it.
  autoCode(item: VaultItem): boolean {
    return item.hasTotp && item.totpType !== "hotp";
  }

  async nextHotp(item: VaultItem): Promise<void> {
    if (this.busyId) return;
    this.busyId = item.id;
    try {
      const code = await firstValueFrom(this.api.nextHotp(item.id));
      await this.copy(code.code, "Code copied.");
    } catch {
      this.error = "Could not get a code.";
    } finally {
      this.busyId = "";
    }
  }

  async tick(): Promise<void> {
    if (!this.pageVisible()) return;
    await this.totp.refresh(this.visibleTotpIds());
  }

  private handleVisibilityChange(): void {
    if (!this.pageVisible()) return;
    void this.tick();
    void this.loadApprovals();
  }

  private pageVisible(): boolean {
    return globalThis.document?.visibilityState !== "hidden";
  }

  toggleMenu(item: VaultItem): void {
    this.menuId = this.menuId === item.id ? "" : item.id;
    this.confirmDeleteId = "";
  }

  async copyCode(item: VaultItem): Promise<void> {
    const code = this.totp.code(item.id)?.code;
    if (!code) return;
    await this.copy(code, "Code copied.");
  }

  async copyPassword(item: VaultItem): Promise<void> {
    const secret = await this.fetchReveal(item);
    if (!secret?.password) {
      if (secret) this.flash("No password saved for this item.");
      return;
    }
    await this.copy(secret.password, "Password copied. Clipboard clears in 30 s.");
  }

  async showPassword(item: VaultItem): Promise<void> {
    const secret = await this.fetchReveal(item);
    if (!secret) return;
    this.setRevealed({ itemId: item.id, label: "Password", value: secret.password || "", notes: secret.notes || "" });
  }

  async exportSecret(item: VaultItem): Promise<void> {
    this.busyId = item.id;
    try {
      const result = await firstValueFrom(this.api.totpSecret(item.id));
      this.setRevealed({ itemId: item.id, label: "Authenticator link", value: String(result?.otpauthUri || "") });
    } catch (error) {
      this.handleSecretError(error);
    } finally {
      this.busyId = "";
    }
  }

  async copyRevealed(): Promise<void> {
    if (this.revealed?.value) await this.copy(this.revealed.value, "Copied. Clipboard clears in 30 s.");
  }

  private async fetchReveal(item: VaultItem): Promise<{ password: string; notes: string } | null> {
    this.busyId = item.id;
    try {
      return await firstValueFrom(this.api.reveal(item.id));
    } catch (error) {
      this.handleSecretError(error);
      return null;
    } finally {
      this.busyId = "";
    }
  }

  private handleSecretError(error: unknown): void {
    if (isVaultReauthRequired(error)) {
      this.reauthNeeded = true;
      return;
    }
    this.error = vaultErrorMessage(error, "Could not reveal this item.");
  }

  signInAgain(): void {
    this.clearRevealed();
    globalThis.location?.assign(vaultReauthUrl());
  }

  private setRevealed(secret: RevealedSecret): void {
    this.clearRevealed();
    this.reauthNeeded = false;
    this.revealed = secret;
    this.revealTimer = setTimeout(() => this.clearRevealed(), vaultSecretTtlMs);
  }

  clearRevealed(): void {
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = null;
    this.revealed = null;
  }

  private async copy(value: string, message: string): Promise<void> {
    try {
      const copied = await copySecret(value);
      this.flash(copied ? message : "Clipboard is unavailable in this browser.");
    } catch {
      this.flash("Clipboard access was denied.");
    }
  }

  private flash(message: string): void {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = ""; }, 4_000);
  }

  openAdd(): void {
    this.formError = "";
    this.editing = "new";
  }

  openEdit(item: VaultItem): void {
    this.formError = "";
    this.menuId = "";
    this.editing = item;
  }

  editingItem(): VaultItem | null {
    return this.editing && this.editing !== "new" ? this.editing : null;
  }

  async saveItem(input: VaultItemInput): Promise<void> {
    const target = this.editingItem();
    this.formBusy = true;
    this.formError = "";
    try {
      const result = await firstValueFrom(target ? this.api.updateItem(target.id, input) : this.api.createItem(input));
      if (result?.item) this.upsert(result.item);
      if (target) this.totp.forget(target.id);
      this.editing = null;
      this.flash(target ? "Saved." : "Added to vault.");
      void this.load();
    } catch (error) {
      this.formError = vaultErrorMessage(error, "Could not save this item.");
    } finally {
      this.formBusy = false;
    }
  }

  async deleteItem(item: VaultItem): Promise<void> {
    this.busyId = item.id;
    try {
      await firstValueFrom(this.api.deleteItem(item.id));
      this.items = this.items.filter((entry) => entry.id !== item.id);
      this.totp.forget(item.id);
      if (this.revealed?.itemId === item.id) this.clearRevealed();
      this.menuId = "";
      this.confirmDeleteId = "";
      this.flash(`Deleted ${item.name}.`);
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not delete this item.");
    } finally {
      this.busyId = "";
    }
  }

  openGrants(item: VaultItem): void {
    this.menuId = "";
    this.grantsItem = item;
  }

  openFill(item: VaultItem): void {
    this.menuId = "";
    this.fillItem = item;
  }

  fillDone(desktop: string): void {
    this.fillItem = null;
    this.flash(`Filled into ${desktop}.`);
  }

  grantsSaved(item: VaultItem): void {
    this.upsert(item);
    this.grantsItem = null;
    this.flash("Thread access updated.");
  }

  importDone(): void {
    void this.load();
  }

  grantCount(item: VaultItem): number {
    return Array.isArray(item.threadGrants) ? item.threadGrants.length : 0;
  }

  private upsert(item: VaultItem): void {
    const index = this.items.findIndex((entry) => entry.id === item.id);
    this.items = index >= 0 ? this.items.map((entry) => (entry.id === item.id ? item : entry)) : [...this.items, item];
  }
}
