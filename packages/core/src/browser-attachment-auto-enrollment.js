export async function ensureAutomaticAttachmentEnrollment(adapter = {}) {
  const recipient = await adapter.ensureIdentity();
  const registered = await adapter.registerRecipient(recipient);
  const key = registered?.key || {};
  if (key.status === "pending_verification") {
    if (!key.id || !key.challenge?.ciphertext) throw new Error("attachment_encryption_challenge_missing");
    const proof = await adapter.decryptChallenge(key.challenge.ciphertext);
    await adapter.verifyRecipient(key.id, proof);
  } else if (key.status !== "active") {
    throw new Error("attachment_encryption_recipient_not_active");
  }

  let status = await adapter.status();
  if (!status?.policy?.enabled || !status?.policy?.required) {
    await adapter.requirePolicy();
    status = await adapter.status();
  }
  if (!status?.ready || !status?.policy?.enabled || !status?.policy?.required) {
    throw new Error("attachment_encryption_bootstrap_incomplete");
  }
  return status;
}
