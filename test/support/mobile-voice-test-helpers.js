import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export function generateMobileDeviceKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKey,
    publicJwk: publicKey.export({ format: "jwk" }),
  };
}

export function signEs256Proof(privateKey, payload) {
  return sign("sha256", Buffer.from(String(payload), "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

export function verifyEs256Proof(publicKey, payload, signature) {
  try {
    return verify("sha256", Buffer.from(String(payload), "utf8"), {
      key: publicKey,
      dsaEncoding: "ieee-p1363",
    }, Buffer.from(String(signature), "base64url"));
  } catch {
    return false;
  }
}

function nextLine(buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === "\n") return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
    if (character !== "\r") continue;
    if (index + 1 === buffer.length) return null;
    return {
      line: buffer.slice(0, index),
      rest: buffer.slice(index + (buffer[index + 1] === "\n" ? 2 : 1)),
    };
  }
  return null;
}

export class SseDecoder {
  constructor() {
    this.buffer = "";
    this.utf8 = new StringDecoder("utf8");
    this.lastEventId = "";
    this.resetEvent();
  }

  resetEvent() {
    this.data = [];
    this.event = "";
    this.pendingId = undefined;
    this.retry = undefined;
  }

  dispatch(events) {
    if (!this.data.length) {
      this.resetEvent();
      return;
    }
    if (this.pendingId !== undefined) this.lastEventId = this.pendingId;
    events.push({
      id: this.lastEventId,
      event: this.event || "message",
      data: this.data.join("\n"),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    });
    this.resetEvent();
  }

  processLine(line, events) {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.pendingId = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? this.utf8.write(chunk) : String(chunk);
    const events = [];
    for (;;) {
      const line = nextLine(this.buffer);
      if (!line) break;
      this.buffer = line.rest;
      this.processLine(line.line, events);
    }
    return events;
  }

  finish() {
    const events = [];
    this.buffer += this.utf8.end();
    if (this.buffer) {
      this.processLine(this.buffer, events);
      this.buffer = "";
    }
    return events;
  }
}

export function decodeSseChunks(chunks) {
  const decoder = new SseDecoder();
  const events = [];
  for (const chunk of chunks) events.push(...decoder.push(chunk));
  events.push(...decoder.finish());
  return events;
}

export function lastEventIdHeaders(eventId, headers = {}) {
  const value = String(eventId ?? "").trim();
  return value ? { ...headers, "Last-Event-ID": value } : { ...headers };
}

export function assertSafePublicError(response, { forbidden = [] } = {}) {
  assert.ok(response && typeof response === "object", "response is required");
  assert.ok(Number(response.status) >= 400 && Number(response.status) < 600, `expected failure status, got ${response.status}`);
  const body = response.body ?? response.json ?? {};
  const error = String(body?.error || "");
  assert.match(error, /^[a-z][a-zA-Z0-9_. -]{0,159}$/, "error must be a bounded public value");
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /(?:^|[\\/])(?:home|root|Users|private|var|etc|tmp)[\\/]/i);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\/);
  assert.doesNotMatch(serialized, /\b(?:stack|authorization|accessToken|refreshToken|privateKey)\b/i);
  for (const value of forbidden) {
    const secret = String(value || "");
    if (secret) assert.equal(serialized.includes(secret), false, "error leaked forbidden request or credential data");
  }
  return error;
}

export async function eventually(check, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError || new Error("eventually_timed_out");
}
