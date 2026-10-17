import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { OwnerSelfChatJournal, selfChatError } from '../packages/connectors/src/whatsapp-owner-selfchat-journal.js';
import { createOwnerSelfChatWrapper, assertRootOwnedPath } from '../packages/connectors/src/whatsapp-owner-selfchat-wrapper.js';
import { verifyOwnerSelfChatIdentity } from '../packages/connectors/src/whatsapp-owner-selfchat-identity.js';
import { attestOwnerSelfChatAccount } from '../packages/connectors/src/whatsapp-owner-selfchat-attestation.js';
import { createOwnerSelfChatAdapter } from '../packages/connectors/src/whatsapp-owner-selfchat-adapter.js';
import { listenOwnerSelfChatAdapter } from '../packages/connectors/src/whatsapp-owner-selfchat-socket.js';
import { assertOwnerSelfChatBridgePolicy } from '../packages/connectors/src/whatsapp-owner-selfchat-bridge-policy.js';
import { ownerSelfChatTransportContract } from '../packages/connectors/src/whatsapp-owner-selfchat-transport.js';

// Explicit operator-only entrypoint. Nothing in the application starts this.
async function main() {
  const [action,configPath]=process.argv.slice(2);
  if (!['challenge','verify','serve'].includes(action) || !configPath)
    throw selfChatError('selfchat_usage_action_config');
  if(process.getuid?.()!==0) throw selfChatError('selfchat_operator_identity_required');
  await assertRootOwnedPath(configPath,{privateFile:true});
  await assertRootOwnedPath(new URL(import.meta.url).pathname);
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  if(config.installApproved!==true || !config.threadIds?.includes(config.homeThreadId))
    throw selfChatError('selfchat_operator_configuration_required');
  await assertRootOwnedPath(path.dirname(config.journalPath),{directory:true});
  const journal=new OwnerSelfChatJournal(config.journalPath,{accountId:config.accountId,chatId:config.chatId,activatedAt:config.activatedAt});
  const runner=createOwnerSelfChatWrapper(config);
  if(action==='challenge') {
    const nonce=randomBytes(16).toString('hex'),issuedAt=new Date().toISOString();
    journal.setMeta('challenge',{nonce,issuedAt});journal.close();
    // This public correlation nonce is not a credential or pairing code.
    process.stdout.write(`In the existing account's Message Yourself chat, send: orkestr-selfchat-verify ${nonce}\n`);
    return;
  }
  if(action==='verify') {
    if(config.identityVerificationMode==='live-account') {
      const runtimeId=await runner.preflight();
      const status=await runner.invoke(['status'],{runtimeId});
      if(await runner.preflight()!==runtimeId)throw selfChatError('selfchat_runtime_changed');
      const identity=attestOwnerSelfChatAccount({config,status,runtimeId});
      journal.setMeta('identity',identity);journal.close();
      process.stdout.write('Live self-chat account attested; human presence was not verified.\n');return;
    }
    const challenge=journal.meta('challenge');
    if(!challenge) throw selfChatError('selfchat_identity_challenge_required');
    const runtimeId=await runner.preflight();
    const status=await runner.invoke(['status'],{runtimeId});
    assertOwnerSelfChatBridgePolicy(status,config.bridgeBuildHash);
    const history=await runner.invoke(['history',config.chatId,'50'],{runtimeId});
    const identity=verifyOwnerSelfChatIdentity({config,history,status,runtimeId,...challenge});
    journal.setMeta('identity',identity);journal.setMeta('challenge',null);journal.close();
    process.stdout.write('Self-chat identity verified; routing is still separately gated.\n');return;
  }
  const adapter=createOwnerSelfChatAdapter({config,journal,...runner});
  // Verify identity before exposing the socket. No fresh auth or status request.
  await adapter.request({operation:'health',accountId:config.accountId,chatId:config.chatId,contract:ownerSelfChatTransportContract(config)});
  await assertRootOwnedPath(path.dirname(config.socketPath),{directory:true});
  const server=await listenOwnerSelfChatAdapter({socketPath:config.socketPath,adapter});
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
    adapter.close();
    server.close(()=>{journal.close();process.exit(0);});
  });
}
main().catch(error=>{
  process.stderr.write(`${/^(selfchat_|owner_selfchat_)[a-z_]+$/.test(error.message)?error.message:'selfchat_operator_action_failed'}\n`);
  process.exitCode=1;
});
