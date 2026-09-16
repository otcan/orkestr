import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

export const inboundAttachmentWorkerProtocolVersion = 1;
export const inboundAttachmentWorkerVerdictKind = "inbound_attachment_clean_verdict";

function clean(value = "") {
  return String(value || "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const object = plainObject(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalValue(object[key])]));
}

export function canonicalInboundAttachmentWorkerPayload(value = {}) {
  return JSON.stringify(canonicalValue(value));
}

function hmac(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function macMatches(actual, expected) {
  const left = Buffer.from(clean(actual));
  const right = Buffer.from(clean(expected));
  return left.byteLength > 0 && left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function signInboundAttachmentWorkerRequest({ method = "POST", pathname = "/", issuedAt = "", nonce = "", payload = {} } = {}, token = "") {
  const body = {
    version: inboundAttachmentWorkerProtocolVersion,
    method: clean(method).toUpperCase(),
    pathname: clean(pathname),
    issuedAt: clean(issuedAt),
    nonce: clean(nonce),
    payload,
  };
  return {
    ...body,
    mac: hmac(clean(token), canonicalInboundAttachmentWorkerPayload(body)),
  };
}

export function verifyInboundAttachmentWorkerRequest(request = {}, token = "") {
  const body = {
    version: Number(request?.version || 0),
    method: clean(request?.method).toUpperCase(),
    pathname: clean(request?.pathname),
    issuedAt: clean(request?.issuedAt),
    nonce: clean(request?.nonce),
    payload: request?.payload,
  };
  if (body.version !== inboundAttachmentWorkerProtocolVersion || !body.method || !body.pathname || !body.issuedAt || !/^[A-Za-z0-9_-]{16,160}$/.test(body.nonce)) {
    return false;
  }
  return macMatches(request?.mac, hmac(clean(token), canonicalInboundAttachmentWorkerPayload(body)));
}

export function signInboundAttachmentWorkerResponse({ pathname = "/", issuedAt = "", nonce = "", result = {} } = {}, token = "") {
  const body = {
    version: inboundAttachmentWorkerProtocolVersion,
    pathname: clean(pathname),
    issuedAt: clean(issuedAt),
    nonce: clean(nonce),
    result,
  };
  return { ...body, mac: hmac(clean(token), canonicalInboundAttachmentWorkerPayload(body)) };
}

export function verifyInboundAttachmentWorkerResponse(response = {}, token = "") {
  const body = {
    version: Number(response?.version || 0),
    pathname: clean(response?.pathname),
    issuedAt: clean(response?.issuedAt),
    nonce: clean(response?.nonce),
    result: response?.result,
  };
  if (body.version !== inboundAttachmentWorkerProtocolVersion || !body.pathname || !body.issuedAt || !/^[A-Za-z0-9_-]{16,160}$/.test(body.nonce)) return false;
  return macMatches(response?.mac, hmac(clean(token), canonicalInboundAttachmentWorkerPayload(body)));
}

function unsignedVerdict(verdict = {}) {
  const { signature, ...unsigned } = plainObject(verdict) || {};
  return unsigned;
}

export function signInboundAttachmentWorkerVerdict(verdict = {}, privateKeyPem = "") {
  const unsigned = {
    ...unsignedVerdict(verdict),
    version: inboundAttachmentWorkerProtocolVersion,
    kind: inboundAttachmentWorkerVerdictKind,
  };
  const key = createPrivateKey(privateKeyPem);
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(canonicalInboundAttachmentWorkerPayload(unsigned)), key).toString("base64url"),
  };
}

export function verifyInboundAttachmentWorkerVerdict(verdict = {}, publicKeyPem = "") {
  const unsigned = unsignedVerdict(verdict);
  if (Number(unsigned.version || 0) !== inboundAttachmentWorkerProtocolVersion || clean(unsigned.kind) !== inboundAttachmentWorkerVerdictKind) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(
      null,
      Buffer.from(canonicalInboundAttachmentWorkerPayload(unsigned)),
      key,
      Buffer.from(clean(verdict?.signature), "base64url"),
    );
  } catch {
    return false;
  }
}
