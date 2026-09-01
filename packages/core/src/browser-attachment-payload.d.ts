export interface DecodedOrkestrAttachmentPayload {
  filename: string;
  mimetype: string;
  bytes: Uint8Array;
}

export function decodeOrkestrAttachmentPayload(value: Uint8Array): Promise<DecodedOrkestrAttachmentPayload>;
