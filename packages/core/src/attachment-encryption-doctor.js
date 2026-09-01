import fs from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";
import { attachmentEncryptionStatus } from "./attachment-encryption-registry.js";
import { validateEncryptedPublishedAttachment } from "./encrypted-attachment-publication.js";
import { listThreadMessages, listThreads } from "./threads.js";

async function publicationResidue(env = process.env) {
  const root = path.join(dataPaths(env).home, "uploads");
  const findings = { plaintext: 0, incomplete: 0 };
  const threadDirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const threadDir of threadDirs) {
    if (!threadDir.isDirectory()) continue;
    const published = path.join(root, threadDir.name, "published");
    const entries = await fs.readdir(published, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".tmp")) findings.incomplete += 1;
      else if (!entry.name.endsWith(".age")) findings.plaintext += 1;
    }
  }
  return findings;
}

async function publicationMessageFindings(env = process.env) {
  const findings = { plaintext: 0, historicalPlaintext: 0, undeliverable: 0 };
  for (const thread of await listThreads(env)) {
    const status = await attachmentEncryptionStatus(thread.ownerUserId, env);
    const policy = status.policy;
    if (!policy.enabled) continue;
    const firstVerifiedAt = status.keys
      .map((key) => Date.parse(key.verifiedAt || ""))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    const enforcementAt = Date.parse(policy.updatedAt || "") || firstVerifiedAt || 0;
    for (const message of await listThreadMessages(thread.id, env)) {
      if (String(message.role || "").trim().toLowerCase() !== "assistant") continue;
      for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
        if (attachment.encrypted !== true) {
          const publishedAt = Date.parse(message.createdAt || message.timestamp || message.updatedAt || "");
          if (enforcementAt && (!Number.isFinite(publishedAt) || publishedAt >= enforcementAt)) findings.plaintext += 1;
          else findings.historicalPlaintext += 1;
          continue;
        }
        const validation = await validateEncryptedPublishedAttachment(attachment, { thread, env });
        if (!validation.ok) findings.undeliverable += 1;
      }
    }
  }
  return findings;
}

export async function attachmentEncryptionDoctorCheck(env = process.env) {
  const owner = env.ORKESTR_ADMIN_USER_ID || "admin";
  const status = await attachmentEncryptionStatus(owner, env);
  const residue = await publicationResidue(env);
  const messageFindings = await publicationMessageFindings(env);
  const expiredChallenges = status.keys.filter((key) =>
    key.status === "pending_verification" && key.challenge?.expiresAt && Date.parse(key.challenge.expiresAt) <= Date.now()
  ).length;
  const migrationState = await readJson(dataPaths(env).attachmentEncryptionMigrations, null);
  const incompleteMigrations = (Array.isArray(migrationState?.checkpoints) ? migrationState.checkpoints : [])
    .filter((checkpoint) => checkpoint?.phase === "ciphertext_staged").length;
  if (residue.plaintext || residue.incomplete || messageFindings.plaintext || messageFindings.undeliverable) {
    return {
      id: "attachment_encryption",
      label: "Attachment encryption",
      status: "error",
      severity: "error",
      summary: `${residue.plaintext + messageFindings.plaintext} plaintext, ${residue.incomplete} incomplete, and ${messageFindings.undeliverable} undeliverable encrypted publication(s) found.`,
      plaintextPublicationFiles: residue.plaintext,
      incompletePublicationFiles: residue.incomplete,
      plaintextMessageAttachments: messageFindings.plaintext,
      historicalPlaintextMessageAttachments: messageFindings.historicalPlaintext,
      undeliverableCiphertextAttachments: messageFindings.undeliverable,
      repair: "Quarantine publication residue, verify ciphertext checksums, and rerun migration before publishing attachments.",
    };
  }
  if (status.policy.enabled && !status.ready) {
    return {
      id: "attachment_encryption",
      label: "Attachment encryption",
      status: "error",
      severity: "error",
      summary: "Mandatory attachment encryption has no verified active recipient.",
      repair: "Register an age recipient and complete the private-key possession challenge.",
    };
  }
  if (expiredChallenges) {
    return {
      id: "attachment_encryption",
      label: "Attachment encryption",
      status: "warning",
      severity: "warning",
      summary: `${expiredChallenges} recipient verification challenge(s) expired.`,
      repair: "Register the recipient again to issue a new short-lived challenge.",
    };
  }
  if (incompleteMigrations) {
    return {
      id: "attachment_encryption",
      label: "Attachment encryption",
      status: "warning",
      severity: "warning",
      incompleteMigrationCheckpoints: incompleteMigrations,
      summary: `${incompleteMigrations} encrypted attachment migration checkpoint(s) await message commit.`,
      repair: "Rerun the same per-thread migration; the validated ciphertext checkpoint will be reused without plaintext publication.",
    };
  }
  return {
    id: "attachment_encryption",
    label: "Attachment encryption",
    status: "ok",
    severity: "info",
    activeRecipients: status.keys.filter((key) => key.status === "active").length,
    revokedRecipients: status.keys.filter((key) => key.status === "revoked").length,
    pendingRecipients: status.keys.filter((key) => key.status === "pending_verification").length,
    historicalPlaintextMessageAttachments: messageFindings.historicalPlaintext,
    summary: status.policy.enabled
      ? `${status.keys.filter((key) => key.status === "active").length} verified recipient(s); published attachments fail closed; ${messageFindings.historicalPlaintext} historical plaintext attachment(s) left unchanged.`
      : "Recipient encryption is available and not enabled for this owner.",
  };
}
