import { DatePipe, JsonPipe, KeyValuePipe } from "@angular/common";
import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { firstValueFrom } from "rxjs";
import { ApiService, AttachmentEncryptionKey, AttachmentEncryptionStatus, InstanceStatusResponse } from "./api.service";
import { AttachmentDecryptionService } from "./attachment-decryption.service";
import { AttachmentEncryptionBootstrapService } from "./attachment-encryption-bootstrap.service";

@Component({
  selector: "ork-instance-settings-page",
  imports: [DatePipe, FormsModule, JsonPipe, KeyValuePipe],
  templateUrl: "./instance-settings-page.component.html",
})
export class InstanceSettingsPageComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly attachmentDecryption = inject(AttachmentDecryptionService);
  private readonly attachmentEncryptionBootstrap = inject(AttachmentEncryptionBootstrapService);

  busy = false;
  error = "";
  snapshot: InstanceStatusResponse | null = null;
  attachmentEncryption: AttachmentEncryptionStatus | null = null;
  recipientLabel = "";
  recipientPublicKey = "";
  verificationIdentity = "";
  verifyingKeyId = "";
  browserIdentity = "";
  rememberBrowserIdentity = true;
  encryptionBusy = false;
  encryptionError = "";

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.busy = true;
    try {
      this.snapshot = await firstValueFrom(this.api.instanceStatus());
      this.attachmentEncryption = await firstValueFrom(this.api.attachmentEncryptionStatus());
      this.error = "";
    } catch (error) {
      this.error = this.errorText(error);
    } finally {
      this.busy = false;
    }
  }

  desiredJson(): string {
    return JSON.stringify(this.snapshot?.config || {}, null, 2);
  }

  mailboxConfigured(): boolean {
    return Object.keys(this.snapshot?.config?.mailboxes || {}).length > 0;
  }

  browserKeyUnlocked(): boolean {
    return this.attachmentDecryption.isUnlocked();
  }

  async unlockBrowserKey(): Promise<void> {
    if (!this.browserIdentity.trim() || this.encryptionBusy) return;
    this.encryptionBusy = true;
    try {
      await this.attachmentDecryption.unlock(this.browserIdentity, this.rememberBrowserIdentity);
      await this.attachmentEncryptionBootstrap.ensureReady(true);
      this.browserIdentity = "";
      this.encryptionError = "";
      this.attachmentEncryption = await firstValueFrom(this.api.attachmentEncryptionStatus());
    } catch (error) {
      this.encryptionError = this.errorText(error);
    } finally {
      this.encryptionBusy = false;
    }
  }

  downloadRecoveryIdentity(): void {
    const identity = this.attachmentDecryption.exportIdentity();
    if (!identity) return;
    const blob = new Blob([`${identity}\n`], { type: "text/plain" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "orkestr-age-recovery-key.txt";
    link.rel = "noopener";
    link.hidden = true;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    }
  }

  async registerRecipient(): Promise<void> {
    const recipient = this.recipientPublicKey.trim();
    if (!recipient || this.encryptionBusy) return;
    this.encryptionBusy = true;
    try {
      await firstValueFrom(this.api.registerAttachmentEncryptionRecipient({ recipient, label: this.recipientLabel.trim() }));
      this.recipientPublicKey = "";
      this.recipientLabel = "";
      this.encryptionError = "";
      this.attachmentEncryption = await firstValueFrom(this.api.attachmentEncryptionStatus());
    } catch (error) {
      this.encryptionError = this.errorText(error);
    } finally {
      this.encryptionBusy = false;
    }
  }

  beginRecipientVerification(key: AttachmentEncryptionKey): void {
    this.verifyingKeyId = key.id;
    this.verificationIdentity = "";
    this.encryptionError = "";
  }

  cancelRecipientVerification(): void {
    this.verificationIdentity = "";
    this.verifyingKeyId = "";
  }

  async verifyRecipient(key: AttachmentEncryptionKey): Promise<void> {
    if (!key.challenge?.ciphertext || (!this.verificationIdentity.trim() && !this.browserKeyUnlocked()) || this.encryptionBusy) return;
    this.encryptionBusy = true;
    try {
      const ciphertext = Uint8Array.from(atob(key.challenge.ciphertext), (character) => character.charCodeAt(0));
      if (this.verificationIdentity.trim()) {
        await this.attachmentDecryption.unlock(this.verificationIdentity, this.rememberBrowserIdentity);
      }
      const proof = await this.attachmentDecryption.decryptText(ciphertext);
      await firstValueFrom(this.api.verifyAttachmentEncryptionRecipient(key.id, proof));
      this.encryptionError = "";
      this.attachmentEncryption = await firstValueFrom(this.api.attachmentEncryptionStatus());
    } catch (error) {
      this.encryptionError = this.errorText(error);
    } finally {
      this.verificationIdentity = "";
      this.verifyingKeyId = "";
      this.encryptionBusy = false;
    }
  }

  async revokeRecipient(key: AttachmentEncryptionKey): Promise<void> {
    if (this.encryptionBusy || !window.confirm(`Revoke ${key.fingerprint} for future publications? Existing encrypted files will not change.`)) return;
    this.encryptionBusy = true;
    try {
      await firstValueFrom(this.api.revokeAttachmentEncryptionRecipient(key.id));
      this.encryptionError = "";
      this.attachmentEncryption = await firstValueFrom(this.api.attachmentEncryptionStatus());
    } catch (error) {
      this.encryptionError = this.errorText(error);
    } finally {
      this.encryptionBusy = false;
    }
  }

  private errorText(error: unknown): string {
    if (error && typeof error === "object") {
      const record = error as { error?: unknown; message?: unknown };
      if (record.error && typeof record.error === "object" && "error" in record.error) {
        return String((record.error as { error?: unknown }).error || "instance_status_error");
      }
      if (record.message) return String(record.message);
    }
    return String(error || "instance_status_error");
  }
}
