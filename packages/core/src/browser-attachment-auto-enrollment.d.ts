export interface AutomaticAttachmentEnrollmentAdapter<TStatus> {
  ensureIdentity(): Promise<string>;
  registerRecipient(recipient: string): Promise<{
    key: {
      id: string;
      status: string;
      challenge?: { ciphertext?: string } | null;
    };
  }>;
  decryptChallenge(ciphertext: string): Promise<string>;
  verifyRecipient(recipientId: string, proof: string): Promise<unknown>;
  status(): Promise<TStatus>;
  requirePolicy(): Promise<unknown>;
}

export function ensureAutomaticAttachmentEnrollment<TStatus>(
  adapter: AutomaticAttachmentEnrollmentAdapter<TStatus>,
): Promise<TStatus>;
