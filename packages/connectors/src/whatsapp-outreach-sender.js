import {assertOutreachOpen, digest, outreachError, validateOutreachRequest, validOutreachProviderId} from './whatsapp-outreach-policy.js';

export const outreachBackendRequestId = (policy, requestId) => `outreach-${digest([policy.fingerprint, requestId]).slice(0,48)}`;

// Backends are operator-selected and private. A caller cannot supply a URL,
// command, attachment, extra recipient, sender override or coordinator token.
export function createOutreachSender({policy, journal, state, backends, now = Date.now}) {
  let tail = Promise.resolve();
  async function checkControl() {
    const control = await state();
    // Provider approval is terminal even if a later config accidentally flips
    // back. Observing it on status also latches the durable campaign stop.
    if (control?.officialCloudApiApproved === true) journal.stop('official_cloud_api_approved');
    assertOutreachOpen(control, now(), policy);
  }
  function checkStopped() {
    if (journal.stopped()) throw outreachError('stopped');
    if (journal.hasUncertain()) throw outreachError('uncertainty_hold', 409);
  }
  function send(request) {
    // Snapshot before the first await; callers cannot mutate admitted identity.
    request = Object.freeze({...request});
    const work = tail.catch(() => {}).then(async () => {
      const hash = validateOutreachRequest(policy, request);
      const existing = journal.previous(request, hash);
      if (existing) return existing; // Receipt lookup never sends or consumes quota.
      checkStopped();
      await checkControl();
      const backend = backends[request.accountId];
      if (!backend) throw outreachError('backend_missing', 503);
      const health = await backend.health();
      if (health?.ready !== true || health?.identityMatches !== true) throw outreachError('account_not_ready', 503);
      // Health may have waited past the cutoff or an operator stop. Check again.
      await checkControl();
      checkStopped();
      const prior = journal.reserve(request, hash, now());
      if (prior) return prior;
      try {
        const result = await backend.send({...request, requestId: outreachBackendRequestId(policy, request.requestId)});
        const ids = result?.ids;
        if (result?.ok !== true || !Array.isArray(ids) || ids.length !== 1
            || !validOutreachProviderId(ids[0])) throw outreachError('delivery_uncertain', 409);
        journal.settle(request.requestId, ids[0], now());
        return {ok: true, ids, state: 'sent', duplicate: result.duplicate === true};
      } catch {
        // Even a timeout/error may follow a provider acceptance. Never fall back,
        // release the recipient, switch accounts or retry this request here.
        journal.uncertain(request.requestId, now());
        throw outreachError('delivery_uncertain', 409);
      }
    });
    tail = work;
    return work;
  }
  return {send, stop: reason => journal.stop(reason), receipt: (accountId, requestId) => journal.receipt(accountId, requestId),
    async status() {
      let blockedReason = null;
      try {await checkControl(); checkStopped();} catch (error) {blockedReason = error.message;}
      return {...journal.status(now()), readyToAttempt: blockedReason === null, blockedReason,
        maxNewPer24h: policy.maxNewPer24h, minSpacingMs: policy.minSpacingMs};
    }};
}
