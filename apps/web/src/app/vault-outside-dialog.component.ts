import { Component, EventEmitter, Input, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { VaultApiService, VaultItem } from "./vault-api.service";
import { VaultOutsideApiService } from "./vault-outside-api";
import { encryptVaultShare, shareCryptoSupported } from "./vault-outside-crypto";
import { copySecret, isVaultReauthRequired, vaultErrorMessage } from "./vault-secrets";

// "Share…" (item set) and "Request from someone…" (no item) dialogs for
// people outside Orkestr (docs/vault-sharing.md). Share reveals the password
// through the recent-sign-in reveal API, encrypts it here and sends only the
// envelope; the key exists only in the link shown once below.

@Component({
  selector: "ork-vault-outside-dialog",
  styleUrl: "./vault-dialog.css",
  template: `
<div class="modal-backdrop" (click)="close.emit()">
  <form class="worker-dialog vault-dialog" (click)="$event.stopPropagation()" (submit)="$event.preventDefault(); submit()">
    @if (item) {
      <h3>Share {{ item.name }}</h3>
      <p class="vault-dialog-text">Creates a link anyone can open without an Orkestr account. The password is encrypted in this browser; the server never sees it.</p>
    } @else {
      <h3>Request a password from someone</h3>
      <p class="vault-dialog-text">Creates a link where someone outside Orkestr can send you a password. It is encrypted in their browser and lands in your vault.</p>
    }
    @if (url) {
      <label>Link (shown once)
        <input readonly [value]="url" data-analytics-ignore data-private (focus)="$any($event.target).select()">
      </label>
      @if (passphrase) {
        <p class="vault-dialog-text">Tell the passphrase to the recipient through a different channel.</p>
      }
      <div class="dialog-actions">
        <button type="button" (click)="copyLink()">Copy link</button>
        <button class="secondary" type="button" (click)="close.emit()">Done</button>
      </div>
    } @else {
      @if (!item) {
        <label>Item name <input [value]="name" (input)="name = $any($event.target).value" maxlength="120" required autocomplete="off"></label>
        <label class="checkbox-row"><input type="checkbox" [checked]="once" (change)="once = $any($event.target).checked"> Single use (released to a thread once)</label>
      }
      <label>Expires after
        <select [value]="ttl" (change)="ttl = $any($event.target).value">
          <option value="1h">1 hour</option><option value="1d">1 day</option><option value="15m">15 minutes</option>
        </select>
      </label>
      @if (item) {
        <label>Views allowed <input type="number" min="1" max="10" [value]="views" (input)="views = +$any($event.target).value"></label>
        <label>Passphrase (optional) <input type="password" autocomplete="new-password" data-private [value]="passphrase" (input)="passphrase = $any($event.target).value"></label>
      }
      <label>Note for the recipient (optional) <input [value]="label" (input)="label = $any($event.target).value" maxlength="200" autocomplete="off"></label>
      @if (error) {
        <p class="vault-form-error" role="alert">{{ error }}</p>
      }
      <div class="dialog-actions">
        <button class="secondary" type="button" (click)="close.emit()">Cancel</button>
        <button type="submit" [disabled]="busy">{{ busy ? "Creating…" : "Create link" }}</button>
      </div>
    }
  </form>
</div>`,
})
export class VaultOutsideDialogComponent {
  private readonly vault = inject(VaultApiService);
  private readonly outside = inject(VaultOutsideApiService);
  @Input() item: VaultItem | null = null;
  @Output() readonly created = new EventEmitter<void>();
  @Output() readonly reauth = new EventEmitter<void>();
  @Output() readonly close = new EventEmitter<void>();

  name = "";
  once = false;
  ttl = "1h";
  views = 1;
  passphrase = "";
  label = "";
  url = "";
  busy = false;
  error = "";

  async submit(): Promise<void> {
    this.error = "";
    if (this.item && this.passphrase && this.passphrase.length < 8) {
      this.error = "Use a passphrase of at least 8 characters.";
      return;
    }
    if (!shareCryptoSupported()) {
      this.error = "This browser cannot encrypt here (a secure https connection is required).";
      return;
    }
    this.busy = true;
    try {
      const label = this.label.trim() || undefined;
      if (this.item) {
        const revealed = await firstValueFrom(this.vault.reveal(this.item.id));
        if (!revealed?.password) throw new Error("This item has no password.");
        const { envelope, key } = await encryptVaultShare(revealed.password, this.passphrase);
        const views = Math.min(10, Math.max(1, Math.floor(this.views) || 1));
        const result = await firstValueFrom(this.outside.share({ envelope, name: this.item.name, ttl: this.ttl, views, label }));
        this.url = `${result.url}#${key}`;
      } else {
        const result = await firstValueFrom(this.outside.request({ name: this.name.trim(), once: this.once, ttl: this.ttl, label }));
        this.url = result.url;
      }
      this.created.emit();
    } catch (error) {
      if (isVaultReauthRequired(error)) {
        this.reauth.emit();
        return;
      }
      this.error = error instanceof Error && !("status" in error) ? error.message : vaultErrorMessage(error, "Could not create the link.");
    } finally {
      this.busy = false;
    }
  }

  async copyLink(): Promise<void> {
    await copySecret(this.url).catch(() => false);
  }
}
