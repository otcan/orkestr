import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from "@angular/core";
import { FormsModule } from "@angular/forms";
import type { VaultItem, VaultItemInput } from "./vault-api.service";
import { VaultQrScanComponent } from "./vault-qr-scan.component";
import {
  PasswordCharsets,
  generatePassword,
  passwordDefaultLength,
  passwordMaxLength,
  passwordMinLength,
} from "./vault-secrets";

@Component({
  selector: "ork-vault-item-form",
  imports: [FormsModule, VaultQrScanComponent],
  templateUrl: "./vault-item-form.component.html",
  styleUrl: "./vault-dialog.css",
})
export class VaultItemFormComponent implements OnChanges, OnDestroy {
  @Input() item: VaultItem | null = null;
  @Input() busy = false;
  @Input() error = "";
  @Output() readonly save = new EventEmitter<VaultItemInput>();
  @Output() readonly cancel = new EventEmitter<void>();

  readonly minLength = passwordMinLength;
  readonly maxLength = passwordMaxLength;
  name = "";
  url = "";
  username = "";
  password = "";
  showPassword = false;
  notes = "";
  notesTouched = false;
  authenticator = "";
  clearPassword = false;
  clearAuthenticator = false;
  generatorOpen = false;
  length = passwordDefaultLength;
  charsets: PasswordCharsets = { lower: true, upper: true, digits: true, symbols: true };
  localError = "";

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes["item"]) return;
    this.name = this.item?.name || "";
    this.url = this.item?.url || "";
    this.username = this.item?.username || "";
    this.wipeSecrets();
  }

  ngOnDestroy(): void {
    this.wipeSecrets();
  }

  get editing(): boolean {
    return !!this.item;
  }

  generate(): void {
    this.password = generatePassword(this.length, this.charsets);
    this.clearPassword = false;
  }

  toggleCharset(key: keyof PasswordCharsets, enabled: boolean): void {
    const next = { ...this.charsets, [key]: enabled };
    if (!Object.values(next).some(Boolean)) return;
    this.charsets = next;
    if (this.password) this.generate();
  }

  setLength(value: number): void {
    this.length = Math.min(passwordMaxLength, Math.max(passwordMinLength, Number(value) || passwordDefaultLength));
    if (this.password) this.generate();
  }

  applyScanned(values: string[]): void {
    const single = values.find((value) => value.toLowerCase().startsWith("otpauth://"));
    if (single) {
      this.authenticator = single;
      this.clearAuthenticator = false;
      this.localError = "";
    } else {
      this.localError = "That is a Google Authenticator export. Use Import to add all of its accounts.";
    }
  }

  submit(): void {
    const name = this.name.trim();
    if (!name) {
      this.localError = "Name is required.";
      return;
    }
    this.localError = "";
    this.save.emit(this.buildInput(name));
  }

  buildInput(name: string): VaultItemInput {
    const input: VaultItemInput = { name, url: this.url.trim(), username: this.username.trim() };
    if (!this.editing) {
      if (!input.url) delete input.url;
      if (!input.username) delete input.username;
    }
    if (this.password) input.password = this.password;
    else if (this.editing && this.clearPassword) input.password = "";
    if (this.editing ? this.notesTouched : this.notes) input.notes = this.notes;
    const authenticator = this.authenticator.trim();
    if (authenticator) {
      if (/^otpauth:\/\//i.test(authenticator)) input.totpUri = authenticator;
      else input.totpSecret = authenticator.replace(/\s+/g, "").toUpperCase();
    } else if (this.editing && this.clearAuthenticator) {
      input.totpUri = "";
    }
    return input;
  }

  private wipeSecrets(): void {
    this.password = "";
    this.notes = "";
    this.notesTouched = false;
    this.authenticator = "";
    this.clearPassword = false;
    this.clearAuthenticator = false;
    this.showPassword = false;
  }
}
