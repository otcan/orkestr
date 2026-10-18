// Temporary operator approval for the existing phone-code pairing endpoint.
// It grants no delivery, history, reset, logout or recipient permissions.
export function createScopedPairingPermit(config, { now = Date.now } = {}) {
  const attempt = config.pairingAttempt;
  const expires = Date.parse(attempt?.expiresAt || '');
  const issued = Date.parse(attempt?.issuedAt || '');
  const valid = () => Boolean(attempt && Number.isFinite(issued) && Number.isFinite(expires)
    && issued <= now() && now() < expires && expires - issued <= 30 * 60_000
    && /^\d+@c\.us$/.test(config.ownChatId || ''));
  let claimed = false;
  return {
    requestAllowed(method, url, body) {
      if (!valid() || method !== 'POST' || url.pathname !== `/accounts/${encodeURIComponent(config.workerAccountId)}/start-phone`) return false;
      if (body === undefined) return true; // URL preflight; body must also be checked after parsing.
      return body && Object.keys(body).every(k => ['phoneNumber', 'showNotification', 'intervalMs'].includes(k))
        && body.phoneNumber === config.ownChatId.split('@')[0]
        && body.showNotification === false && body.intervalMs === 1_800_000;
    },
    claim(phoneNumber) {
      if (claimed || !valid() || phoneNumber !== config.ownChatId.split('@')[0]) throw new Error('scoped_pairing_attempt_denied');
      claimed = true;
    },
    allowsAuthentication() { return claimed && valid(); },
  };
}
