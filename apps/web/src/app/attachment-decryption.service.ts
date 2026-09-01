import { Injectable } from "@angular/core";
import * as age from "age-encryption";
import { decodeOrkestrAttachmentPayload } from "../../../../packages/core/src/browser-attachment-payload.js";

const rememberedIdentityKey = "orkestr.attachment-age-identity.v1";

export interface DecryptedAttachment {
  filename: string;
  mimetype: string;
  bytes: Uint8Array;
}

@Injectable({ providedIn: "root" })
export class AttachmentDecryptionService {
  private identity = this.readRememberedIdentity();

  isUnlocked(): boolean {
    return Boolean(this.identity);
  }

  async ensureIdentity(): Promise<string> {
    if (this.identity) {
      try {
        return await age.identityToRecipient(this.identity);
      } catch {
        this.lock();
      }
    }
    return this.unlock(await age.generateIdentity(), true);
  }

  exportIdentity(): string {
    return this.identity;
  }

  async unlock(identity: string, remember = true): Promise<string> {
    const candidate = String(identity || "").trim();
    if (!candidate.startsWith("AGE-SECRET-KEY-1")) throw new Error("attachment_identity_invalid");
    let recipient = "";
    try {
      recipient = await age.identityToRecipient(candidate);
    } catch {
      throw new Error("attachment_identity_invalid");
    }
    this.identity = candidate;
    try {
      if (remember) globalThis.localStorage?.setItem(rememberedIdentityKey, candidate);
      else globalThis.localStorage?.removeItem(rememberedIdentityKey);
    } catch {
      // Restricted browsers still retain the identity for this page session.
    }
    return recipient;
  }

  lock(): void {
    this.identity = "";
    try {
      globalThis.localStorage?.removeItem(rememberedIdentityKey);
    } catch {
      // The in-memory identity is already gone.
    }
  }

  async decryptText(ciphertext: Uint8Array, identity = ""): Promise<string> {
    const selectedIdentity = String(identity || this.identity || "").trim();
    if (!selectedIdentity) throw new Error("attachment_identity_locked");
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(selectedIdentity);
    return decrypter.decrypt(ciphertext, "text");
  }

  async download(downloadUrl: string): Promise<DecryptedAttachment> {
    if (!this.identity) throw new Error("attachment_identity_locked");
    const response = await fetch(downloadUrl, { credentials: "same-origin", headers: { accept: "application/age" } });
    if (!response.ok) throw new Error(`attachment_download_failed_${response.status}`);
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(this.identity);
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(await decrypter.decrypt(new Uint8Array(await response.arrayBuffer())));
    } catch {
      throw new Error("attachment_decryption_failed");
    }
    const attachment = await decodeOrkestrAttachmentPayload(plaintext) as DecryptedAttachment;
    const downloadableBytes = new Uint8Array(attachment.bytes.byteLength);
    downloadableBytes.set(attachment.bytes);
    const blob = new Blob([downloadableBytes.buffer], { type: attachment.mimetype });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = attachment.filename;
    link.rel = "noopener";
    link.hidden = true;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    }
    return attachment;
  }

  private readRememberedIdentity(): string {
    try {
      const identity = String(globalThis.localStorage?.getItem(rememberedIdentityKey) || "").trim();
      return identity.startsWith("AGE-SECRET-KEY-1") ? identity : "";
    } catch {
      return "";
    }
  }
}
