import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { ensureAutomaticAttachmentEnrollment } from "../../../../packages/core/src/browser-attachment-auto-enrollment.js";
import { ApiService, AttachmentEncryptionStatus } from "./api.service";
import { AttachmentDecryptionService } from "./attachment-decryption.service";

@Injectable({ providedIn: "root" })
export class AttachmentEncryptionBootstrapService {
  private readonly api = inject(ApiService);
  private readonly attachmentDecryption = inject(AttachmentDecryptionService);
  private inFlight: Promise<AttachmentEncryptionStatus> | null = null;
  private completed = false;

  async ensureReady(force = false): Promise<AttachmentEncryptionStatus> {
    if (force) this.completed = false;
    if (this.completed) return firstValueFrom(this.api.attachmentEncryptionStatus());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.enrollAndEnforce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async enrollAndEnforce(): Promise<AttachmentEncryptionStatus> {
    const status = await ensureAutomaticAttachmentEnrollment<AttachmentEncryptionStatus>({
      ensureIdentity: () => this.attachmentDecryption.ensureIdentity(),
      registerRecipient: (recipient) => firstValueFrom(this.api.registerAttachmentEncryptionRecipient({
        recipient,
        label: "Automatic WebUI browser",
      })),
      decryptChallenge: (ciphertext) => this.attachmentDecryption.decryptText(Uint8Array.from(
        atob(ciphertext),
        (character) => character.charCodeAt(0),
      )),
      verifyRecipient: (recipientId, proof) => firstValueFrom(this.api.verifyAttachmentEncryptionRecipient(recipientId, proof)),
      status: () => firstValueFrom(this.api.attachmentEncryptionStatus()),
      requirePolicy: () => firstValueFrom(this.api.updateAttachmentEncryptionPolicy({ enabled: true, required: true })),
    });
    this.completed = true;
    return status;
  }
}
