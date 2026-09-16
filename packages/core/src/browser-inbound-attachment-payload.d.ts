export interface BrowserInboundAttachmentFile {
  name: string;
  type: string;
  size: number;
  stream(): ReadableStream<Uint8Array>;
}

export interface BrowserInboundAttachmentCapability {
  version: number;
  sessionId: string;
  keyId: string;
  keyVersion: number;
  recipient: string;
  purpose: string;
  expiresAt: string;
  maxPlaintextBytes: number;
  signature: string;
}

export interface BrowserInboundAttachmentDescriptor extends Partial<BrowserInboundAttachmentCapability> {
  sessionId?: string;
  id?: string;
  keyId?: string;
  descriptor?: BrowserInboundAttachmentCapability;
}

export function safeInboundAttachmentFilename(value?: string): string;
export function safeInboundAttachmentMimetype(value?: string): string;
export function createInboundAttachmentPayloadStream(file: BrowserInboundAttachmentFile, descriptor?: BrowserInboundAttachmentDescriptor): ReadableStream<Uint8Array>;
export const payloadMagic: string;
export const maximumHeaderBytes: number;
