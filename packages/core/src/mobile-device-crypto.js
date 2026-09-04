import crypto from "node:crypto";

export function mobileAuthError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeDevicePublicJwk(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw mobileAuthError("mobile_device_public_key_required", 400);
  }
  const jwk = {
    kty: String(input.kty || ""),
    crv: String(input.crv || ""),
    x: String(input.x || ""),
    y: String(input.y || ""),
  };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || input.d) {
    throw mobileAuthError("mobile_device_public_key_invalid", 400);
  }
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw mobileAuthError("mobile_device_public_key_invalid", 400);
    }
    return jwk;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw mobileAuthError("mobile_device_public_key_invalid", 400);
  }
}

export function jwkThumbprint(jwk = {}) {
  const normalized = normalizeDevicePublicJwk(jwk);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      crv: normalized.crv,
      kty: normalized.kty,
      x: normalized.x,
      y: normalized.y,
    }))
    .digest("base64url");
}

export function contentSha256ForRequest(request = {}) {
  if (Buffer.isBuffer(request?.rawBody)) return sha256(request.rawBody.toString("utf8"));
  const header = String(
    request?.headers?.["x-orkestr-content-sha256"] ||
    request?.headers?.["X-Orkestr-Content-Sha256"] ||
    "",
  ).trim().toLowerCase();
  return header || sha256("");
}

export function requestProofPath(request = {}) {
  const value = String(request?.originalUrl || request?.url || "/");
  try {
    const parsed = new URL(value, "http://orkestr.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return value.split("#")[0] || "/";
  }
}

function decodeBase64UrlJson(value = "") {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  } catch {
    throw mobileAuthError("mobile_device_proof_invalid", 401);
  }
}

export function verifyEs256Proof(compact = "", publicJwk = {}) {
  const parts = String(compact || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw mobileAuthError("mobile_device_proof_invalid", 401);
  }
  const header = decodeBase64UrlJson(parts[0]);
  if (header.alg !== "ES256") throw mobileAuthError("mobile_device_proof_alg_invalid", 401);
  const key = crypto.createPublicKey({ key: normalizeDevicePublicJwk(publicJwk), format: "jwk" });
  const verified = crypto.verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(parts[2], "base64url"),
  );
  if (!verified) throw mobileAuthError("mobile_device_proof_signature_invalid", 401);
  return decodeBase64UrlJson(parts[1]);
}

export function assertProofFresh(claims = {}, audience = "", now = Date.now()) {
  if (claims.aud !== audience) throw mobileAuthError("mobile_device_proof_audience_invalid", 401);
  if (!claims.jti || String(claims.jti).length > 160) throw mobileAuthError("mobile_device_proof_jti_required", 401);
  const iatMs = Number(claims.iat) * 1000;
  const expMs = Number(claims.exp) * 1000;
  if (!Number.isFinite(iatMs) || !Number.isFinite(expMs)) {
    throw mobileAuthError("mobile_device_proof_time_invalid", 401);
  }
  if (iatMs - 60_000 > now || expMs <= now || expMs - now > 5 * 60_000) {
    throw mobileAuthError("mobile_device_proof_expired", 401);
  }
}
