const payloadMagic = "ORKESTR-INBOUND-UPLOAD/1";
const maximumHeaderBytes = 64 * 1024;

function clean(value = "") {
  return String(value || "").trim();
}

export function safeInboundAttachmentFilename(value = "") {
  const filename = clean(value)
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 240);
  return filename || "attachment";
}

export function safeInboundAttachmentMimetype(value = "") {
  const mimetype = clean(value).toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimetype)
    ? mimetype
    : "application/octet-stream";
}

export function createInboundAttachmentPayloadStream(file, descriptor = {}) {
  if (!file?.stream || typeof file.stream !== "function") throw new Error("inbound_upload_browser_stream_unsupported");
  const capability = descriptor.descriptor && typeof descriptor.descriptor === "object" ? descriptor.descriptor : descriptor;
  const metadata = {
    version: 1,
    sessionId: clean(capability.sessionId || capability.id),
    keyId: clean(capability.keyId),
    filename: safeInboundAttachmentFilename(file.name),
    mimetype: safeInboundAttachmentMimetype(file.type),
    plaintextSize: Number(file.size || 0),
    descriptor: {
      version: Number(capability.version || 0),
      sessionId: clean(capability.sessionId || capability.id),
      keyId: clean(capability.keyId),
      keyVersion: Number(capability.keyVersion || 0),
      recipient: clean(capability.recipient),
      purpose: clean(capability.purpose),
      expiresAt: clean(capability.expiresAt),
      maxPlaintextBytes: Number(capability.maxPlaintextBytes || 0),
      signature: clean(capability.signature),
    },
  };
  if (!metadata.sessionId || !metadata.keyId || !metadata.descriptor.signature || !Number.isSafeInteger(metadata.plaintextSize) || metadata.plaintextSize < 0) {
    throw new Error("inbound_upload_descriptor_invalid");
  }
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  if (header.byteLength > maximumHeaderBytes) throw new Error("inbound_upload_metadata_too_large");
  const prefix = new TextEncoder().encode(`${payloadMagic}\n${header.byteLength}\n`);
  const reader = file.stream().getReader();
  let stage = 0;
  return new ReadableStream({
    async pull(controller) {
      if (stage === 0) {
        stage += 1;
        controller.enqueue(prefix);
        return;
      }
      if (stage === 1) {
        stage += 1;
        controller.enqueue(header);
        return;
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export { payloadMagic, maximumHeaderBytes };
