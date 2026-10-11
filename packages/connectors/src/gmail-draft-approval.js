import { getGmailAccessToken, readGmailToken } from "./gmail.js";
import { googleWorkspaceTokenHasCapability } from "./google-workspace-scopes.js";

function clean(value = "") {
  return String(value ?? "").trim();
}

function draftError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function parsePlainTextDraft(raw = "") {
  const encoded = clean(raw);
  if (!encoded || encoded.length > 120_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    throw draftError("gmail_draft_approval_raw_unavailable");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
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
  if (!/^text\/plain(?:\s*;|$)/i.test(headers["content-type"] || "") ||
      !["", "7bit", "8bit"].includes((headers["content-transfer-encoding"] || "").toLowerCase())) {
    throw draftError("gmail_draft_approval_unsupported_mime");
  }
  const body = decoded.slice(separator.index + separator[0].length).trim();
  if (body.length > 60_000) throw draftError("gmail_draft_approval_content_too_large");
  if (!headers.to) throw draftError("gmail_draft_approval_to_required");
  return {
    raw: encoded,
    details: {
      from: headers.from || "",
      to: headers.to,
      cc: headers.cc || "",
      bcc: headers.bcc || "",
      subject: headers.subject || "",
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
