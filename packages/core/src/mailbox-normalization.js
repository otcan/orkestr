import { createHash, randomUUID } from "node:crypto";
import { adminUserId, normalizeUserId } from "./users.js";
import { parseRawMime } from "./mailbox-mime.js";

export const mailboxStatuses = new Set([
  "pending",
  "verification-pending",
  "active",
  "suspended",
  "deleting",
  "deleted",
  "dead-lettered",
  "rotated",
]);
export const acceptingMailboxStatuses = new Set(["pending", "verification-pending", "active"]);

const defaultMailboxDomain = "in.example.test";

export function nowIso() {
  return new Date().toISOString();
}

export function clean(value = "") {
  return String(value || "").trim();
}

export function cleanLower(value = "") {
  return clean(value).toLowerCase();
}

export function sha256(value = "") {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function mailboxError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function positiveInteger(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function safeSegment(value = "", fallback = "mailbox", max = 64) {
  return cleanLower(value)
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/[_.-]{2,}/g, "-")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, max) || fallback;
}

export function mailboxDomain(env = process.env) {
  return cleanLower(env.ORKESTR_MAILBOX_DOMAIN || defaultMailboxDomain)
    .replace(/^@+/, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || defaultMailboxDomain;
}

function normalizeStatus(value = "pending") {
  const status = cleanLower(value || "pending");
  return mailboxStatuses.has(status) ? status : "pending";
}

export function normalizeMailboxTarget(input = {}, env = process.env) {
  const source = input.target && typeof input.target === "object" && !Array.isArray(input.target) ? input.target : {};
  const rawType = cleanLower(input.targetType || source.type || (input.tenantVmId || source.tenantVmId ? "vm" : "main"));
  const type = rawType === "vm" || rawType === "tenant-vm" || rawType === "tenant_vm" ? "vm" : "main";
  if (type === "vm") {
    return {
      type: "vm",
      tenantVmId: safeSegment(input.tenantVmId || source.tenantVmId || source.id || source.vmId, "", 96),
      ownerUserId: normalizeUserId(input.ownerUserId || source.ownerUserId || source.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
    };
  }
  return {
    type: "main",
    ownerUserId: normalizeUserId(input.ownerUserId || input.userId || source.ownerUserId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
  };
}

function generatedLocalPart(target = {}, purpose = "mailbox", suffix = "") {
  const cleanedSuffix = safeSegment(suffix || randomUUID().replace(/-/g, "").slice(0, 10), "mailbox", 16);
  const prefixSource = target.type === "vm"
    ? `${safeSegment(target.tenantVmId, "vm", 36)}-${safeSegment(purpose, "mailbox", 24)}`
    : safeSegment(purpose, "mailbox", 40);
  const maxPrefix = Math.max(1, 64 - cleanedSuffix.length - 1);
  const prefix = safeSegment(prefixSource, "mailbox", maxPrefix).replace(/[_.-]+$/g, "") || "mailbox";
  return `${prefix}-${cleanedSuffix}`.slice(0, 64);
}

export function extractAddress(value = "") {
  const text = cleanLower(value).replace(/^mailto:/, "");
  const angle = /<([^<>@\s]+@[^<>@\s]+)>/.exec(text);
  const candidate = angle?.[1] || text.split(/[,\s;]/).find((part) => part.includes("@")) || text;
  const stripped = cleanLower(candidate).replace(/^<+|>+$/g, "");
  return /^[^@\s]+@[^@\s]+$/.test(stripped) ? stripped : "";
}

function addressParts(input = {}, target = {}, env = process.env) {
  const explicitAddress = extractAddress(input.address || input.email || "");
  if (explicitAddress) {
    const [localPart, domain] = explicitAddress.split("@");
    return {
      address: explicitAddress,
      localPart: safeSegment(localPart, "", 64),
      domain: cleanLower(domain),
    };
  }
  const domain = mailboxDomain(env);
  const localPart = safeSegment(input.localPart || generatedLocalPart(target, input.purpose || input.label, input.suffix), "mailbox", 64);
  return {
    address: `${localPart}@${domain}`,
    localPart,
    domain,
  };
}

function normalizeVerification(input = {}) {
  const source = input.verification && typeof input.verification === "object" && !Array.isArray(input.verification)
    ? input.verification
    : {};
  const candidates = Array.isArray(source.lastCandidates || source.candidates)
    ? (source.lastCandidates || source.candidates)
    : [];
  return {
    state: cleanLower(source.state || input.verificationState || (source.verifiedAt || input.verifiedAt ? "verified" : "")),
    provider: cleanLower(source.provider || input.verificationProvider || ""),
    requestedAt: clean(source.requestedAt || input.verificationRequestedAt),
    verifiedAt: clean(source.verifiedAt || input.verifiedAt),
    lastCandidateAt: clean(source.lastCandidateAt || input.verificationLastCandidateAt),
    lastCandidates: candidates.slice(0, 5).map((candidate) => {
      const item = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
      return {
        type: cleanLower(item.type || ""),
        value: clean(item.value || "").slice(0, 80),
        href: clean(item.href || "").slice(0, 600),
      };
    }).filter((candidate) => candidate.type && (candidate.value || candidate.href)),
    attemptCount: Math.max(0, Math.floor(Number(source.attemptCount || input.verificationAttemptCount || 0) || 0)),
    lastError: clean(source.lastError || input.verificationLastError).slice(0, 500),
  };
}

function normalizeLifecycle(input = {}) {
  const source = input.lifecycle && typeof input.lifecycle === "object" && !Array.isArray(input.lifecycle)
    ? input.lifecycle
    : {};
  return {
    state: cleanLower(source.state || input.lifecycleState || "ready"),
    mtaRevision: clean(source.mtaRevision || input.mtaRevision),
    propagationState: cleanLower(source.propagationState || input.propagationState || "pending"),
    propagationStartedAt: clean(source.propagationStartedAt || input.propagationStartedAt),
    propagationCompletedAt: clean(source.propagationCompletedAt || input.propagationCompletedAt),
    lastError: clean(source.lastError || input.lifecycleLastError).slice(0, 500),
  };
}

function normalizeLimits(input = {}, env = process.env) {
  const source = input.limits && typeof input.limits === "object" && !Array.isArray(input.limits) ? input.limits : {};
  return {
    maxMessageBytes: positiveInteger(source.maxMessageBytes ?? env.ORKESTR_MAILBOX_MAX_MESSAGE_BYTES, 25 * 1024 * 1024, {
      min: 1024,
      max: 100 * 1024 * 1024,
    }),
    maxAttachments: positiveInteger(source.maxAttachments ?? env.ORKESTR_MAILBOX_MAX_ATTACHMENTS, 25, { min: 0, max: 100 }),
  };
}

export function normalizeMailbox(input = {}, env = process.env) {
  const target = normalizeMailboxTarget(input, env);
  const ownerUserId = target.ownerUserId || normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const purpose = safeSegment(input.purpose || input.label || input.displayName || "mailbox", "mailbox", 48);
  const parts = addressParts({ ...input, purpose }, target, env);
  const now = nowIso();
  return {
    id: safeSegment(input.id || input.mailboxId || `mbx-${parts.localPart}`, "mailbox", 96),
    ownerUserId,
    address: parts.address,
    localPart: parts.localPart,
    domain: parts.domain,
    displayName: clean(input.displayName || input.label || purpose),
    purpose,
    status: normalizeStatus(input.status),
    target,
    targetSelection: normalizeTargetSelection(input.targetSelection || input.targetResolution || {}),
    source: cleanLower(input.source || "admin"),
    verification: normalizeVerification(input),
    lifecycle: normalizeLifecycle(input),
    limits: normalizeLimits(input, env),
    createdAt: clean(input.createdAt) || now,
    updatedAt: clean(input.updatedAt) || now,
    deletedAt: clean(input.deletedAt),
    rotatedAt: clean(input.rotatedAt),
  };
}

function normalizeTargetSelection(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const warning = source.shadowBoundaryWarning && typeof source.shadowBoundaryWarning === "object" && !Array.isArray(source.shadowBoundaryWarning)
    ? source.shadowBoundaryWarning
    : {};
  return {
    ok: source.ok === true,
    selectedInstanceId: clean(source.selectedInstanceId || source.instanceId || ""),
    selectedInstanceType: cleanLower(source.selectedInstanceType || source.instanceType || source.targetType || ""),
    ownerUserId: normalizeUserId(source.ownerUserId || ""),
    selectionSource: cleanLower(source.selectionSource || ""),
    ambiguityResult: cleanLower(source.ambiguityResult || ""),
    error: cleanLower(source.error || ""),
    candidateCount: Math.max(0, Math.floor(Number(source.candidateCount || 0) || 0)),
    authorizedCandidateCount: Math.max(0, Math.floor(Number(source.authorizedCandidateCount || 0) || 0)),
    shadowBoundaryWarning: {
      eligible: warning.eligible === true,
      emitted: warning.emitted === true,
      resourceType: cleanLower(warning.resourceType || ""),
      mode: cleanLower(warning.mode || ""),
      reason: cleanLower(warning.reason || "not_evaluated"),
      notificationId: clean(warning.notificationId || ""),
    },
  };
}

export function publicMailbox(mailbox = {}, env = process.env) {
  const normalized = normalizeMailbox(mailbox, env);
  return {
    id: normalized.id,
    ownerUserId: normalized.ownerUserId,
    address: normalized.address,
    localPart: normalized.localPart,
    domain: normalized.domain,
    displayName: normalized.displayName,
    purpose: normalized.purpose,
    status: normalized.status,
    target: { ...normalized.target },
    targetSelection: { ...normalized.targetSelection },
    source: normalized.source,
    verification: { ...normalized.verification },
    lifecycle: { ...normalized.lifecycle },
    limits: { ...normalized.limits },
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    deletedAt: normalized.deletedAt,
    rotatedAt: normalized.rotatedAt,
  };
}

export function normalizeRecipientList(input = {}) {
  const values = [];
  const push = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    if (value && typeof value === "object") {
      push(value.address || value.email || value.value || value.rcptTo || value.to);
      return;
    }
    const address = extractAddress(value);
    if (address) values.push(address);
  };
  push(input.recipient);
  push(input.recipients);
  push(input.to);
  push(input.envelope?.rcptTo);
  push(input.envelope?.recipient);
  push(input.envelope?.recipients);
  return [...new Set(values)];
}

const parsedMimeCache = new WeakMap();

function rawMimeValue(input = {}) {
  return input.rawMime ?? input.mime ?? input.rfc822 ?? input.raw ?? "";
}

function rawMimeSize(value = "") {
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Buffer.byteLength(String(value || ""), "utf8");
}

async function parsedMime(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = rawMimeValue(input);
  if (!rawMimeSize(raw) || !clean(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw)) return null;
  if (parsedMimeCache.has(input)) return parsedMimeCache.get(input);
  const parsed = parseRawMime(raw).catch(() => ({
    headers: {},
    body: {},
    attachments: [],
    sizeBytes: rawMimeSize(raw),
    parseError: "mailbox_mime_parse_failed",
  }));
  parsedMimeCache.set(input, parsed);
  return parsed;
}

async function normalizeHeaders(input = {}) {
  const source = input.headers && typeof input.headers === "object" && !Array.isArray(input.headers) ? input.headers : {};
  const mime = (await parsedMime(input))?.headers || {};
  return {
    messageId: clean(source.messageId || source["message-id"] || input.messageId || mime.messageId),
    subject: clean(source.subject || input.subject || mime.subject).slice(0, 500),
    from: clean(source.from || input.from || mime.from).slice(0, 500),
    date: clean(source.date || input.date || mime.date).slice(0, 120),
    // These headers drive ingress-only loop suppression. Retain bounded,
    // normalized values rather than raw MIME so no untrusted source can grow
    // durable policy records through header size alone.
    autoSubmitted: clean(source.autoSubmitted || source["auto-submitted"] || input.autoSubmitted || input["auto-submitted"] || mime.autoSubmitted).slice(0, 120),
    references: clean(source.references || input.references || mime.references).slice(0, 4_000),
    inReplyTo: clean(source.inReplyTo || source["in-reply-to"] || input.inReplyTo || input["in-reply-to"] || mime.inReplyTo).slice(0, 1_000),
    xOrkestrOrigin: clean(source.xOrkestrOrigin || source["x-orkestr-origin"] || input.xOrkestrOrigin || input["x-orkestr-origin"] || mime.xOrkestrOrigin).slice(0, 120),
  };
}

function normalizeProvenance(input = {}) {
  const envelope = input.envelope && typeof input.envelope === "object" && !Array.isArray(input.envelope) ? input.envelope : {};
  const auth = input.auth && typeof input.auth === "object" && !Array.isArray(input.auth) ? input.auth : {};
  return {
    mailFrom: clean(envelope.mailFrom || envelope.from || input.mailFrom).slice(0, 500),
    rcptTo: normalizeRecipientList(input).slice(0, 20),
    sourceIp: clean(envelope.sourceIp || envelope.remoteAddress || input.sourceIp).slice(0, 120),
    helo: clean(envelope.helo || envelope.heloName || input.helo).slice(0, 200),
    tls: clean(envelope.tls || input.tls).slice(0, 120),
    spf: clean(auth.spf || input.spf).slice(0, 80),
    dkim: clean(auth.dkim || input.dkim).slice(0, 80),
    dmarc: clean(auth.dmarc || input.dmarc).slice(0, 80),
    forwardingHint: clean(input.forwardingHint || envelope.forwardingHint).slice(0, 200),
    ingestAdapter: clean(input.ingestAdapter || "mailbox").slice(0, 120),
  };
}

async function bodyParts(input = {}) {
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? input.body : {};
  const mime = (await parsedMime(input))?.body || {};
  const text = clean(body.text ?? input.text ?? mime.text ?? "");
  const html = clean(body.html ?? input.html ?? mime.html ?? "");
  return { text, html };
}

async function bodySnippet(input = {}, maxChars = 500) {
  const { text, html } = await bodyParts(input);
  const source = text || html.replace(/<[^>]*>/g, " ");
  return source.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

async function bodyHash(input = {}) {
  const { text, html } = await bodyParts(input);
  return sha256(`${text}\n${html}`);
}

async function attachmentSummary(input = {}) {
  const mimeAttachments = (await parsedMime(input))?.attachments || [];
  const values = Array.isArray(input.attachments) && input.attachments.length ? input.attachments : mimeAttachments;
  return values.slice(0, 50).map((attachment) => {
    const source = attachment && typeof attachment === "object" ? attachment : {};
    return {
      filename: clean(source.filename || source.name).slice(0, 240),
      contentType: clean(source.contentType || source.mimetype || source.mimeType).slice(0, 120),
      sizeBytes: Math.max(0, Math.floor(Number(source.sizeBytes || source.size || 0) || 0)),
      contentHash: clean(source.contentHash || source.sha256 || "").slice(0, 128),
      quarantined: source.quarantined === true,
    };
  });
}

export async function extractForwardingVerificationCandidates(input = {}) {
  const headers = await normalizeHeaders(input);
  const { text, html } = await bodyParts(input);
  const source = `${headers.subject}\n${text}\n${html.replace(/<[^>]*>/g, " ")}`.slice(0, 20000);
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    const key = `${candidate.type}:${candidate.value || candidate.href}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  for (const match of source.matchAll(/\b(?:confirmation|forwarding|verification)\s+(?:code|number)[^\S\r\n]*(?:[:#-][^\S\r\n]*)?([a-z0-9-]{6,32})\b/gi)) {
    add({ type: "code", value: clean(match[1]).slice(0, 32) });
  }
  for (const match of source.matchAll(/\bcode\s*[:#-]\s*([a-z0-9-]{6,32})\b/gi)) {
    add({ type: "code", value: clean(match[1]).slice(0, 32) });
  }
  for (const match of source.matchAll(/https:\/\/(?:mail-settings\.google\.com|accounts\.google\.com|outlook\.office\.com|outlook\.live\.com)\/[^\s<>"']{1,500}/gi)) {
    add({ type: "link", href: clean(match[0]).slice(0, 600) });
  }
  return candidates.slice(0, 5);
}

export async function mailboxMessageIdempotencyKey(input = {}, mailbox = {}) {
  const headers = await normalizeHeaders(input);
  const provenance = normalizeProvenance(input);
  const bodyDigest = await bodyHash(input);
  const messageIdentity = headers.messageId
    ? `message-id:${cleanLower(headers.messageId)}`
    : `fallback:${cleanLower(headers.from)}:${cleanLower(headers.subject)}:${provenance.mailFrom.toLowerCase()}:${bodyDigest}`;
  return `mailbox:${mailbox.id || "unknown"}:${sha256(messageIdentity).slice(0, 40)}`;
}

export async function normalizeInboundMailboxMessage(input = {}, mailbox = {}) {
  const headers = await normalizeHeaders(input);
  const provenance = normalizeProvenance(input);
  const attachments = await attachmentSummary(input);
  const mime = await parsedMime(input);
  return {
    mailboxId: mailbox.id || "",
    ownerUserId: mailbox.ownerUserId || "",
    target: mailbox.target ? { ...mailbox.target } : {},
    targetSelection: mailbox.targetSelection ? { ...mailbox.targetSelection } : {},
    headers,
    provenance,
    snippet: await bodySnippet(input),
    bodyHash: await bodyHash(input),
    sizeBytes: Math.max(0, Math.floor(Number(input.sizeBytes || input.body?.sizeBytes || mime?.sizeBytes || 0) || 0)),
    attachments,
    verificationCandidates: await extractForwardingVerificationCandidates(input),
    mimeParseError: clean(mime?.parseError),
  };
}
