import { getGmailAccessToken, readGmailToken } from "./gmail.js";
import { googleWorkspaceTokenHasCapability } from "./google-workspace-scopes.js";

function clean(value = "") {
  return String(value ?? "").trim();
}

function draftError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function decodeUtf8(bytes, error = "gmail_draft_approval_unsupported_charset") {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw draftError(error); }
}

function decodeHeader(value = "") {
  // RFC 2047 ignores linear whitespace between adjacent encoded words.
  value = value.replace(/(\?=)[ \t]+(?==\?)/g, "$1");
  const encodedWord = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
  const decoded = value.replace(encodedWord, (_, charset, encoding, payload) => {
    if (!/^utf-?8$/i.test(charset)) throw draftError("gmail_draft_approval_unsupported_charset");
    let bytes;
    if (encoding.toLowerCase() === "b") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
        throw draftError("gmail_draft_approval_unsupported_mime");
      }
      bytes = Buffer.from(payload, "base64");
    } else {
      const parts = [];
      for (let i = 0; i < payload.length; i++) {
        if (payload[i] === "=") {
          if (!/^[0-9a-f]{2}$/i.test(payload.slice(i + 1, i + 3))) throw draftError("gmail_draft_approval_unsupported_mime");
          parts.push(Number.parseInt(payload.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          const code = payload[i] === "_" ? 32 : payload.charCodeAt(i);
          if (code > 127) throw draftError("gmail_draft_approval_unsupported_mime");
          parts.push(code);
        }
      }
      bytes = Buffer.from(parts);
    }
    return decodeUtf8(bytes);
  });
  if (decoded.includes("=?")) throw draftError("gmail_draft_approval_unsupported_mime");
  return decoded;
}

function parsePlainTextDraft(raw = "") {
  const encoded = clean(raw);
  if (!encoded || encoded.length > 120_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    throw draftError("gmail_draft_approval_raw_unavailable");
  }
  const decoded = decodeUtf8(Buffer.from(encoded, "base64url"));
  if (decoded.includes("\0")) throw draftError("gmail_draft_approval_unsupported_mime");
  const separator = decoded.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) throw draftError("gmail_draft_approval_unsupported_mime");
  const lines = decoded.slice(0, separator.index).split(/\r?\n/);
  const allowed = new Set(["to", "cc", "bcc", "subject", "content-type", "content-transfer-encoding", "mime-version", "from", "date", "message-id"]);
  const headers = {};
  for (const line of lines) {
    if (/^[ \t]/.test(line)) throw draftError("gmail_draft_approval_unsupported_mime");
    const colon = line.indexOf(":");
    if (colon <= 0) throw draftError("gmail_draft_approval_unsupported_mime");
    const name = line.slice(0, colon).toLowerCase();
    if (!allowed.has(name) || Object.hasOwn(headers, name)) throw draftError("gmail_draft_approval_unsupported_mime");
    headers[name] = clean(line.slice(colon + 1));
  }
  const contentType = headers["content-type"] || "";
  if (!/^text\/plain(?:\s*;|$)/i.test(contentType) ||
      !["", "7bit", "8bit"].includes((headers["content-transfer-encoding"] || "").toLowerCase())) {
    throw draftError("gmail_draft_approval_unsupported_mime");
  }
  const charsets = [...contentType.matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/gi)];
  if ((/charset/i.test(contentType) && charsets.length === 0) || charsets.length > 1 ||
      (charsets.length === 1 && !/^(?:utf-?8|us-ascii)$/i.test(charsets[0][1] || charsets[0][2]))) {
    throw draftError("gmail_draft_approval_unsupported_charset");
  }
  const body = decoded.slice(separator.index + separator[0].length);
  if ((!charsets.length || /^us-ascii$/i.test(charsets[0][1] || charsets[0][2])) && /[^\x00-\x7f]/.test(body)) {
    throw draftError("gmail_draft_approval_unsupported_charset");
  }
  if (body.length > 60_000) throw draftError("gmail_draft_approval_content_too_large");
  if (!headers.to) throw draftError("gmail_draft_approval_to_required");
  return {
    raw: encoded,
    details: {
      from: decodeHeader(headers.from || ""),
      to: decodeHeader(headers.to),
      cc: decodeHeader(headers.cc || ""),
      bcc: decodeHeader(headers.bcc || ""),
      subject: decodeHeader(headers.subject || ""),
      body,
    },
  };
}

export async function getGmailDraftApprovalSnapshot(draftId = "", env = process.env, fetchImpl = fetch, options = {}) {
  const id = clean(draftId);
  if (!id) throw draftError("gmail_draft_id_required");
  const token = await readGmailToken(env, options);
  if (!googleWorkspaceTokenHasCapability(token, "gmail_drafts")) {
    throw draftError("google_workspace_capability_not_granted:gmail_drafts", 403);
  }
  const accessToken = await getGmailAccessToken(env, fetchImpl, options);
  const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=raw`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) throw draftError("gmail_draft_approval_fetch_failed", Number(response.status) || 502);
  const draft = await response.json();
  if (clean(draft?.id) !== id) throw draftError("gmail_draft_approval_id_mismatch", 502);
  return { draftId: id, ...parsePlainTextDraft(draft?.message?.raw) };
}
