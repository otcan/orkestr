import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";

// Owner login: the first visitor picks a username and password; after that the
// browser holds a signed JWT (HS256) in an HttpOnly cookie. The signing key is
// random per install (never hard-coded) and lives next to the owner record in
// ORKESTR_HOME, mode 0600. Changing the password bumps tokenVersion, which
// invalidates every issued token.

export const ownerCookieName = "orkestr_owner";
const tokenTtlSeconds = 30 * 24 * 60 * 60;
const scryptParams = { N: 16384, r: 8, p: 1, keylen: 32 };
const usernamePattern = /^[A-Za-z0-9._@-]{1,64}$/;
export const minPasswordLength = 8;

function files(env = process.env) {
  const home = dataPaths(env).home;
  return { owner: path.join(home, "owner-login.json"), secret: path.join(home, "owner-login-secret") };
}

function loginError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

// "missing" only when there is no owner file at all. A file that cannot be
// read or parsed counts as an owner that nobody can sign in as: sign-in stays
// on (fail closed) and setup stays closed.
async function readOwnerRecord(env = process.env) {
  let raw;
  try {
    raw = await fs.readFile(files(env).owner, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { state: "missing", owner: null } : { state: "invalid", owner: null };
  }
  try {
    const owner = JSON.parse(raw);
    return owner?.username && owner?.passwordHash && owner?.salt ? { state: "valid", owner } : { state: "invalid", owner: null };
  } catch {
    return { state: "invalid", owner: null };
  }
}

async function readOwner(env = process.env) {
  return (await readOwnerRecord(env)).owner;
}

async function writeOwner(owner, env = process.env) {
  const file = files(env).owner;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function signingKey(env = process.env) {
  const file = files(env).secret;
  const existing = await fs.readFile(file).catch(() => null);
  if (existing && existing.length >= 32) return existing;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32);
  // "wx" so two first requests cannot both write different keys.
  await fs.writeFile(file, key, { mode: 0o600, flag: "wx" }).catch(() => {});
  return await fs.readFile(file);
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, scryptParams.keylen, { N: scryptParams.N, r: scryptParams.r, p: scryptParams.p }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("base64url"));
    });
  });
}

export async function ownerLoginStatus(env = process.env) {
  const record = await readOwnerRecord(env);
  return { configured: record.state !== "missing", username: record.owner?.username || "", ...(record.state === "invalid" ? { invalid: true } : {}) };
}

export async function ownerLoginConfigured(env = process.env) {
  return (await readOwnerRecord(env)).state !== "missing";
}

// Only while no owner exists. The record is created exclusively so a second
// concurrent setup request cannot replace the first owner.
export async function createOwnerLogin({ username = "", password = "" } = {}, env = process.env) {
  const name = String(username || "").trim();
  if (!usernamePattern.test(name)) throw loginError("owner_username_invalid");
  if (String(password || "").length < minPasswordLength) throw loginError("owner_password_too_short");
  if ((await readOwnerRecord(env)).state !== "missing") throw loginError("owner_login_exists", 409);
  const salt = crypto.randomBytes(16).toString("base64url");
  const owner = {
    username: name,
    salt,
    passwordHash: await hashPassword(password, salt),
    tokenVersion: 1,
    createdAt: new Date().toISOString(),
  };
  const file = files(env).owner;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw loginError("owner_login_exists", 409);
    throw error;
  }
  return { username: name };
}

export async function changeOwnerPassword({ currentPassword = "", newPassword = "" } = {}, env = process.env) {
  const owner = await readOwner(env);
  if (!owner) throw loginError("owner_login_missing", 404);
  if (!(await passwordMatches(owner, currentPassword))) throw loginError("owner_login_invalid", 401);
  if (String(newPassword || "").length < minPasswordLength) throw loginError("owner_password_too_short");
  const salt = crypto.randomBytes(16).toString("base64url");
  await writeOwner({ ...owner, salt, passwordHash: await hashPassword(newPassword, salt), tokenVersion: Number(owner.tokenVersion || 1) + 1, updatedAt: new Date().toISOString() }, env);
}

async function passwordMatches(owner, password) {
  const expected = Buffer.from(String(owner.passwordHash), "base64url");
  const actual = Buffer.from(await hashPassword(password, owner.salt), "base64url");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Failed logins: at most 10 per client per 15 minutes.
const failures = new Map();
const failureWindowMs = 15 * 60 * 1000;
const maxFailures = 10;

function throttleKey(clientKey = "") {
  return String(clientKey || "unknown");
}

function recentFailures(clientKey) {
  const key = throttleKey(clientKey);
  const now = Date.now();
  const list = (failures.get(key) || []).filter((at) => now - at < failureWindowMs);
  failures.set(key, list);
  return list;
}

export async function verifyOwnerLogin({ username = "", password = "", clientKey = "" } = {}, env = process.env) {
  if (recentFailures(clientKey).length >= maxFailures) throw loginError("owner_login_rate_limited", 429);
  const owner = await readOwner(env);
  if (!owner) throw loginError("owner_login_missing", 404);
  const nameOk = String(username || "").trim() === owner.username;
  const passwordOk = await passwordMatches(owner, password);
  if (!nameOk || !passwordOk) {
    recentFailures(clientKey).push(Date.now());
    throw loginError("owner_login_invalid", 401);
  }
  failures.delete(throttleKey(clientKey));
  return issueOwnerToken(owner, env);
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function issueOwnerToken(owner, env = process.env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: owner.username, role: "admin", ver: Number(owner.tokenVersion || 1), iat: now, exp: now + tokenTtlSeconds, jti: crypto.randomUUID() };
  const unsigned = `${base64urlJson({ alg: "HS256", typ: "JWT" })}.${base64urlJson(payload)}`;
  const signature = crypto.createHmac("sha256", await signingKey(env)).update(unsigned).digest("base64url");
  return { token: `${unsigned}.${signature}`, payload };
}

// Returns the verified claims, or null for anything invalid, expired or revoked.
export async function verifyOwnerToken(token = "", env = process.env) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  try {
    if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256") return null;
    const expected = crypto.createHmac("sha256", await signingKey(env)).update(`${header}.${body}`).digest();
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!claims || Number(claims.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    const owner = await readOwner(env);
    if (!owner || claims.sub !== owner.username || Number(claims.ver) !== Number(owner.tokenVersion || 1)) return null;
    if ((owner.revoked || []).some((entry) => entry?.jti === claims.jti)) return null;
    return claims;
  } catch {
    return null;
  }
}

// Logout revokes this one token (other browsers stay signed in). Expired
// entries are dropped so the list stays small.
export async function revokeOwnerToken(jti = "", expiresAt = "", env = process.env) {
  const id = String(jti || "").trim();
  if (!id) return false;
  const owner = await readOwner(env);
  if (!owner) return false;
  const now = Date.now();
  const revoked = (owner.revoked || []).filter((entry) => Date.parse(entry?.expiresAt || "") > now);
  if (!revoked.some((entry) => entry.jti === id)) revoked.push({ jti: id, expiresAt: String(expiresAt || new Date(now + tokenTtlSeconds * 1000).toISOString()) });
  await writeOwner({ ...owner, revoked }, env);
  return true;
}

export function ownerCookieHeader(token, { secure = false, maxAgeSeconds = tokenTtlSeconds } = {}) {
  return `${ownerCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearOwnerCookieHeader({ secure = false } = {}) {
  return `${ownerCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
