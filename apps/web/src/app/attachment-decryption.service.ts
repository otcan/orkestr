import { Injectable } from "@angular/core";
import * as age from "age-encryption";
import {
  browserAttachmentRecipientMatch,
  decodeOrkestrAttachmentPayload,
} from "../../../../packages/core/src/browser-attachment-payload.js";

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

  async read(encryptedAttachment: Record<string, unknown>, signal?: AbortSignal, maximumBytes = Infinity): Promise<DecryptedAttachment> {
    if (!this.identity) throw new Error("attachment_identity_locked");
    let selectedAttachment = encryptedAttachment;
    let downloadUrl = String(selectedAttachment["downloadUrl"] || "").trim();
    if (!downloadUrl) throw new Error("attachment_download_url_missing");
    if (new URL(downloadUrl, document.baseURI).origin !== location.origin) throw new Error("attachment_download_origin_invalid");
    const recipient = await age.identityToRecipient(this.identity);
    if (await browserAttachmentRecipientMatch(selectedAttachment, recipient) === false) {
      const reissueUrl = downloadUrl.replace(/\/download(?:[?#].*)?$/, "/reissue");
      if (reissueUrl === downloadUrl) throw new Error("attachment_reissue_url_invalid");
      const reissueResponse = await fetch(reissueUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      });
      if (!reissueResponse.ok) throw new Error(`attachment_reissue_failed_${reissueResponse.status}`);
      const reissued = await reissueResponse.json() as { attachment?: Record<string, unknown> };
      if (!reissued.attachment || await browserAttachmentRecipientMatch(reissued.attachment, recipient) !== true) {
        throw new Error("attachment_reissue_recipient_missing");
      }
      Object.assign(encryptedAttachment, reissued.attachment);
      selectedAttachment = reissued.attachment;
      downloadUrl = String(selectedAttachment["downloadUrl"] || "").trim();
    }
    const url = new URL(downloadUrl, document.baseURI);
    if (url.origin !== location.origin) throw new Error("attachment_download_origin_invalid");
    const response = await fetch(url, { credentials: "same-origin", headers: { accept: "application/age" }, signal });
    if (!response.ok) throw new Error(`attachment_download_failed_${response.status}`);
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(this.identity);
    let plaintext: Uint8Array;
    try {
      if (Number(response.headers.get("content-length") || 0) > maximumBytes) throw new Error("attachment_preview_too_large");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("attachment_download_empty");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > maximumBytes) throw new Error("attachment_preview_too_large");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const ciphertext = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { ciphertext.set(chunk, offset); offset += chunk.length; }
      plaintext = new Uint8Array(await decrypter.decrypt(ciphertext));
    } catch {
      throw new Error("attachment_decryption_failed");
    }
    return await decodeOrkestrAttachmentPayload(plaintext) as DecryptedAttachment;
  }

  async download(encryptedAttachment: Record<string, unknown>): Promise<DecryptedAttachment> {
    const attachment = await this.read(encryptedAttachment);
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
