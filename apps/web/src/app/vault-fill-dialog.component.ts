import { Component, EventEmitter, Input, OnInit, Output, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ApiService, BrowserSession } from "./api.service";
import { VaultApiService, VaultFillField, VaultItem } from "./vault-api.service";
import { isVaultReauthRequired, vaultErrorMessage } from "./vault-secrets";

// Owner-triggered fill: the server types the credential into the focused
// field of a managed desktop. The value never reaches this page.

function fillFailureMessage(reason = ""): string {
  if (reason === "focus_not_password_field") return "Nothing was typed: click into the password field on the desktop first.";
  if (reason === "focus_not_username_field") return "Nothing was typed: click into the username field on the desktop first.";
  if (reason === "focus_unverifiable") return "Nothing was typed: Orkestr could not check which field has focus on this desktop.";
  return "The desktop did not accept the keystrokes.";
}

@Component({
  selector: "ork-vault-fill-dialog",
  templateUrl: "./vault-fill-dialog.component.html",
  styleUrl: "./vault-dialog.css",
})
export class VaultFillDialogComponent implements OnInit {
  private readonly api = inject(VaultApiService);
  private readonly desktopsApi = inject(ApiService);
  @Input({ required: true }) item!: VaultItem;
  @Output() readonly filled = new EventEmitter<string>();
  @Output() readonly reauth = new EventEmitter<void>();
  @Output() readonly close = new EventEmitter<void>();

  desktops: BrowserSession[] = [];
  desktop = "";
  field: VaultFillField = "password";
  submitAfter = false;
  loading = true;
  busy = false;
  error = "";

  async ngOnInit(): Promise<void> {
    if (!this.item.hasPassword) this.field = "username";
    try {
      const result = await firstValueFrom(this.desktopsApi.browserSessions());
      this.desktops = (result?.sessions || result?.browsers || []).filter((session) => this.slug(session));
      this.desktop = this.slug(this.desktops[0] || {});
    } catch (error) {
      this.error = vaultErrorMessage(error, "Could not load desktops.");
    } finally {
      this.loading = false;
    }
  }

  slug(session: BrowserSession): string {
    return String(session.slug || session.id || "");
  }

  async submit(): Promise<void> {
    if (!this.desktop) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await firstValueFrom(this.api.fill(this.item.id, { desktop: this.desktop, field: this.field, submit: this.submitAfter }));
      if (result?.status === "filled") this.filled.emit(this.desktop);
      else this.error = fillFailureMessage(result?.reason);
    } catch (error) {
      if (isVaultReauthRequired(error)) this.reauth.emit();
      else this.error = vaultErrorMessage(error, "Could not fill into the desktop.");
    } finally {
      this.busy = false;
    }
  }
}
