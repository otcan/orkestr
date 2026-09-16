export async function inboundAttachmentProcessingLeaseIsStale(session, { isProcessingLeaseExpired, runtimeProcessIdentityAlive }) {
  if (!isProcessingLeaseExpired(session)) return false;
  return (await runtimeProcessIdentityAlive(session.processingLease)) === false;
}
