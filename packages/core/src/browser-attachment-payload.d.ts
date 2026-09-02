export interface DecodedOrkestrAttachmentPayload {
  filename: string;
  mimetype: string;
  bytes: Uint8Array;
}

export interface EncryptedBrowserAttachment {
  encryption?: {
    recipientFingerprints?: unknown[];
  };
}

export function decodeOrkestrAttachmentPayload(value: Uint8Array): Promise<DecodedOrkestrAttachmentPayload>;
export function browserAttachmentRecipientFingerprint(recipient?: string): Promise<string>;
export function browserAttachmentRecipientMatch(
  attachment?: EncryptedBrowserAttachment,
  recipient?: string,
): Promise<boolean | null>;
