import { Component, EventEmitter, OnDestroy, Output, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { VaultApiService, VaultImportFormat, VaultImportResult } from "./vault-api.service";
import { VaultQrScanComponent } from "./vault-qr-scan.component";
import { vaultErrorMessage } from "./vault-secrets";

const maxImportBytes = 5 * 1024 * 1024;

@Component({
  selector: "ork-vault-import-dialog",
  imports: [FormsModule, VaultQrScanComponent],
  templateUrl: "./vault-import-dialog.component.html",
  styleUrl: "./vault-dialog.css",
})
export class VaultImportDialogComponent implements OnDestroy {
  private readonly api = inject(VaultApiService);
  @Output() readonly imported = new EventEmitter<VaultImportResult>();
  @Output() readonly close = new EventEmitter<void>();

  readonly formats: Array<{ value: VaultImportFormat; label: string }> = [
    { value: "auto", label: "Detect automatically" },
    { value: "bitwarden", label: "Bitwarden CSV" },
    { value: "1password", label: "1Password CSV" },
    { value: "chrome", label: "Chrome passwords CSV" },
    { value: "otpauth", label: "Authenticator links (otpauth://)" },
  ];
  format: VaultImportFormat = "auto";
  content = "";
  fileName = "";
  busy = false;
  error = "";
  result: VaultImportResult | null = null;

  async pickFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > maxImportBytes) {
      this.error = "That file is larger than 5 MB.";
      return;
    }
    this.error = "";
    this.fileName = file.name;
    this.content = await file.text();
  }

  addScanned(values: string[]): void {
    const existing = this.content.trim();
    this.content = [existing, ...values].filter(Boolean).join("\n");
    if (this.format !== "auto") this.format = "otpauth";
  }

  async submit(): Promise<void> {
    if (!this.content.trim() || this.busy) return;
    this.busy = true;
    this.error = "";
    this.result = null;
    try {
      this.result = await firstValueFrom(this.api.importItems(this.format, this.content));
      this.content = "";
      this.fileName = "";
      this.imported.emit(this.result);
    } catch (error) {
      this.error = vaultErrorMessage(error, "Import failed.");
    } finally {
      this.busy = false;
    }
  }

  reasonLines(): string[] {
    const reasons = this.result?.reasons;
    if (!reasons) return [];
    if (Array.isArray(reasons)) return reasons.slice(0, 10).map((reason) => (typeof reason === "string" ? reason : JSON.stringify(reason)));
    if (typeof reasons === "object") return Object.entries(reasons as Record<string, unknown>).slice(0, 10).map(([key, value]) => `${key}: ${value}`);
    return [String(reasons)];
  }

  ngOnDestroy(): void {
    this.content = "";
  }
}
