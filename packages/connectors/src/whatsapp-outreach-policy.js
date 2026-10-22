import crypto from 'node:crypto';

export const outreachError = (code, statusCode = 403) => Object.assign(new Error(`outreach_${code}`), {statusCode});
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validOutreachProviderId = value => typeof value === 'string'
  && /^(?!summary:)[A-Za-z0-9@._:-]{1,200}$/.test(value);
const id = /^[A-Za-z0-9:._-]{1,160}$/;
const chat = /^\d{6,20}@c\.us$/;

export function outreachPolicy(input) {
  if (!input || !id.test(input.campaignId || '') || !id.test(input.threadId || '')
      || !Array.isArray(input.recipients) || !input.recipients.length || input.recipients.length > 500
      || !input.recipients.every(value => typeof value === 'string' && chat.test(value))
      || new Set(input.recipients).size !== input.recipients.length
      || !Array.isArray(input.accounts) || !input.accounts.length
      || new Set(input.accounts).size !== input.accounts.length || !input.accounts.every(value => id.test(value))
      || !Number.isInteger(input.maxNewPer24h) || input.maxNewPer24h < 1 || input.maxNewPer24h > 20
      || !Number.isInteger(input.minSpacingMs) || input.minSpacingMs < 60_000
      || typeof input.timeZone !== 'string' || !Number.isInteger(input.startHour) || !Number.isInteger(input.endHour)
      || input.startHour < 0 || input.endHour > 24 || input.endHour <= input.startHour)
    throw outreachError('configuration_invalid');
  try {new Intl.DateTimeFormat('en', {timeZone: input.timeZone});} catch {throw outreachError('configuration_invalid');}
  // These limits deliberately have no caller override. Deployment state lives
  // outside the policy contract and is re-read before every backend invocation.
  const contract = {campaignId: input.campaignId, threadId: input.threadId,
    recipients: [...input.recipients].sort(), accounts: [...input.accounts].sort(),
    maxNewPer24h: input.maxNewPer24h, minSpacingMs: input.minSpacingMs,
    timeZone: input.timeZone, startHour: input.startHour, endHour: input.endHour};
  Object.freeze(contract.recipients); Object.freeze(contract.accounts);
  return Object.freeze({...contract, fingerprint: digest(contract)});
}

export function validateOutreachRequest(policy, request) {
  if (!request || Object.keys(request).some(key => !['threadId', 'accountId', 'to', 'text', 'requestId'].includes(key))
      || request.threadId !== policy.threadId || !policy.accounts.includes(request.accountId)
      || !policy.recipients.includes(request.to) || !id.test(request.requestId || '')
      || typeof request.text !== 'string' || !request.text.trim() || request.text.length > 3000)
    throw outreachError('scope_denied');
  return digest([request.threadId, request.accountId, request.to, request.text]);
}

export function assertOutreachOpen(state, timestamp, policy) {
  if (!state || state.enabled !== true || state.officialCloudApiApproved !== false
      || state.baselineImported !== true || state.legacySendsFenced !== true)
    throw outreachError('inactive');
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: policy.timeZone, hourCycle: 'h23', hour: '2-digit'})
    .formatToParts(new Date(timestamp));
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (!(hour >= policy.startHour && hour < policy.endHour)) throw outreachError('outside_window');
}
