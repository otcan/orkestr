import { whatsappAccountLookupKeys } from './whatsapp-account-identity.js';

// Conflict/fallback checks must consider every supplied selector, including
// contradictory legacy fields. First-present resolution could hide overlap.
export function selfChatBindingAccountKeys(binding={},accounts=[]) {
  const fields=['accountId','targetAccountId','senderAccountId','inboundAccountId',
    'bridgeAccountId','receivingAccountId','responderConnectorAccountId',
    'responderAccountId','outboundAccountId','replyAccountId','runtimeAccountId'];
  if(fields.some(key=>binding[key]!=null && typeof binding[key]!=='string')
      || (binding.accountIds!=null && !Array.isArray(binding.accountIds))
      || (Array.isArray(binding.accountIds) && binding.accountIds.some(value=>value!=null && typeof value!=='string')))
    return new Set(); // Unknown account selectors must be fenced by the caller.
  const keys=new Set([...fields.map(key=>binding[key]),
    ...(Array.isArray(binding.accountIds)?binding.accountIds:[])]
    .filter(value=>typeof value==='string' && value.trim()).map(value=>value.trim().toLowerCase()));
  let changed=true;
  while(changed) {
    changed=false;
    for(const account of accounts) {
      const aliases=whatsappAccountLookupKeys(account).map(value=>value.toLowerCase());
      if(!aliases.some(key=>keys.has(key)))continue;
      for(const key of aliases)if(!keys.has(key)){keys.add(key);changed=true;}
    }
  }
  return keys;
}
