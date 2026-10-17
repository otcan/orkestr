import fs from 'node:fs/promises';
import { planOwnerSelfChatRegistration,applyOwnerSelfChatRegistration,retireOwnerSelfChatRegistration } from '../packages/connectors/src/whatsapp-owner-selfchat-registration.js';
import { selfChatError } from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
import { assertRootOwnedPath } from '../packages/connectors/src/whatsapp-owner-selfchat-wrapper.js';

async function main() {
  const [action,filename]=process.argv.slice(2);
  if(!['plan','register','retire'].includes(action) || !filename) throw selfChatError('selfchat_usage_action_config');
  await assertRootOwnedPath(filename);
  const config=JSON.parse(await fs.readFile(filename,'utf8'));
  if(!config.home || !config.scope) throw selfChatError('selfchat_router_configuration_required');
  const env={...process.env,ORKESTR_HOME:config.home,
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN:'0',ORKESTR_WHATSAPP_OWNER_SELFCHAT_SCOPE:JSON.stringify(config.scope)};
  if(action==='plan') {
    const plan=await planOwnerSelfChatRegistration(env);
    // Do not print self chat/phone, journal content, credentials or prompts.
    console.log(JSON.stringify({accountId:plan.account.id,threadCount:plan.threads.length,
      scopeRevision:plan.scopeRevision,primaryBindingsChanged:false}));return;
  }
  if(config.activationApproved!==true) throw selfChatError('selfchat_activation_approval_required');
  if(action==='register') {
    console.log(JSON.stringify(await applyOwnerSelfChatRegistration(await planOwnerSelfChatRegistration(env),env,{approved:true})));return;
  }
  if(action==='retire') { console.log(JSON.stringify(await retireOwnerSelfChatRegistration(env,{approved:true})));return; }
}
main().catch(error=>{
  console.error(/^(selfchat_|owner_selfchat_)[a-z_]+$/.test(error.message)?error.message:'selfchat_router_failed');
  process.exitCode=1;
});
