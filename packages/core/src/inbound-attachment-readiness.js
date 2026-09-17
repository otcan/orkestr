export async function inboundAttachmentUploadReadiness({ threadId, principal, env }, { requireThread, policyFor, workerHealth }) {
  const thread = await requireThread(threadId, principal, env);
  const policy = policyFor(env);
  const worker = policy.localDecryption ? { ready: true, reason: "" } : await workerHealth(env);
  return {
    threadId: thread.id,
    enabled: policy.enabled,
    required: policy.required,
    processingMode: policy.processingMode,
    ready: policy.ready && worker.ready,
    reason: policy.reason || worker.reason,
    limits: { maxFileBytes: policy.maxFileBytes, maxFiles: policy.maxFiles, sessionTtlMs: policy.sessionTtlMs },
  };
}
