// Apply the group extension to a private COPY of the preserving self-chat bridge.
// This changes files only. Service installation and account configuration remain
// deployment concerns; never run this against a live runtime directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const target = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('usage: prepare-scoped-group-bridge.mjs <inactive-bridge-copy>');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = path.join(target, 'scripts/wa_web_bridge.mjs');
const wrapperPath = path.join(target, 'scripts/account-wrapper.mjs');
let bridge = fs.readFileSync(bridgePath, 'utf8');
let wrapper = fs.readFileSync(wrapperPath, 'utf8');
function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('group_bridge_patch_source_mismatch');
  return text.replace(from, to);
}
bridge = replaceOnce(bridge, 'const transportOnly = createTransportOnlyPolicy(process.env);', `import fsSync from 'node:fs';
import { createScopedGroupTransport } from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
const baseTransportOnly = createTransportOnlyPolicy(process.env);
const transportOnly = process.env.WA_OWNER_GROUP_CONFIG
  ? createScopedGroupTransport({config:JSON.parse(fsSync.readFileSync(process.env.WA_OWNER_GROUP_CONFIG,'utf8')),token:process.env.WA_HTTP_TOKEN,base:baseTransportOnly})
  : baseTransportOnly;`);
bridge = replaceOnce(bridge, "client.on('message_create', async (message) => {\n  if (transportOnly.enabled) return;", `client.on('message_create', async (message) => {
    if (transportOnly.enabled) {
      if (transportOnly.groupsMode) await transportOnly.observe(client,message).catch(error=>console.error(JSON.stringify({event:'group_input_error',code:error.message})));
      return;
    }`);
const ready = 'await applyAccountReadyState(accountId, { routerEnabled, recovered: false, client });';
bridge = replaceOnce(bridge, ready, ready + "\n    if(transportOnly.groupsMode) transportOnly.reconcile(client).then(result=>console.error(JSON.stringify({event:'group_reconciliation',...result}))).catch(()=>console.error('group_reconciliation_failed'));");
bridge = replaceOnce(bridge, '  app.use(transportOnly.middleware);\n', '  app.use(transportOnly.middleware);\n  transportOnly.routes?.(app,()=>(bridgeState.ready ? client : null));\n');
bridge = replaceOnce(bridge, 'transportOnly.sendText(client,to,text,requestedAccountId)', 'transportOnly.sendText(client,to,text,requestedAccountId,req.body)');
bridge = replaceOnce(bridge, 'const ready=bridgeState.ready && diagnostics.identityMatches;', 'const ready=bridgeState.ready && diagnostics.identityMatches && !transportOnly.blocked?.();');
bridge = replaceOnce(bridge, 'ownerSelfChatPolicy:transportOnly.policyFields(transportOnlyBuildHash)', "[transportOnly.groupsMode?'groupTransportPolicy':'ownerSelfChatPolicy']:transportOnly.policyFields(transportOnlyBuildHash)");
wrapper = replaceOnce(wrapper, "['serve','status','history','send-text','identity']", "['serve','status','history','send-text','identity','group-meta','group-reply','group-notify']");
wrapper = replaceOnce(wrapper, "  if (command === 'send-text') {", `  if(command==='group-reply' || command==='group-notify') {
    const [to,requestId,parentId,...parts]=args;
    const text=parts.join(' ').trim();
    if(!to || !requestId || !parentId || !text)throw new Error('group_reply_arguments_required');
    printJson(await request(runtime,'/send-text',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to,text,accountId:'main',requestId,parentId,...(command==='group-notify'?{notificationId:requestId}:{})})}));
    return;
  }
  if (command === 'send-text') {`);
const files = ['packages/connectors/src/whatsapp-scoped-group-transport.js',
  'packages/connectors/src/whatsapp-scoped-route-membership.js',
  'packages/connectors/src/whatsapp-group-owner-author.js',
  'packages/connectors/src/whatsapp-group-participant-author.js',
  'packages/connectors/src/whatsapp-scoped-group-formatting.js',
  'packages/connectors/src/whatsapp-scoped-timer-notifications.js',
  'packages/connectors/src/whatsapp-scoped-remote-timer-replies.js',
  'packages/connectors/src/whatsapp-timer-notification-proof.js',
  'packages/connectors/src/whatsapp-delivery-route-fence.js',
  'packages/connectors/src/whatsapp-scoped-group-media.js',
  'packages/connectors/src/whatsapp-inbound-media-browser.js',
  'packages/connectors/src/whatsapp-inbound-media-diagnostics.js',
  'packages/connectors/src/whatsapp-media-self-decrypt.js',
  'packages/connectors/src/whatsapp-scoped-coordinator.js',
  'packages/connectors/src/whatsapp-scoped-delegates.js',
  'packages/connectors/src/whatsapp-scoped-dynamic-groups.js',
  'packages/connectors/src/whatsapp-scoped-reply-files.js',
  'packages/connectors/src/whatsapp-scoped-relay-reply-files.js',
  'packages/connectors/src/whatsapp-scoped-operator-notices.js',
  'packages/connectors/src/whatsapp-scoped-direct-chats.js',
  'packages/connectors/src/scoped-group-progress.js',
  'packages/connectors/src/scoped-group-inbox.js',
  'packages/connectors/src/scoped-group-input-intake.js',
  'packages/connectors/src/scoped-group-reply-quote.js',
  'packages/connectors/src/scoped-group-acknowledgements.js',
  'packages/connectors/src/scoped-acknowledgement-activity.js',
  'packages/connectors/src/scoped-relay-serial.js',
  'packages/connectors/src/whatsapp-scoped-remote-watch.js',
  'packages/connectors/src/whatsapp-scoped-group-relay.js', 'scripts/scoped-group-relay.mjs', 'apps/cli/src/api-client.js'];
const buildHash = crypto.createHash('sha256').update(bridge.replace(/const transportOnlyBuildHash = '[a-f0-9]+';/, '')).update(wrapper);
for (const relative of files) buildHash.update(fs.readFileSync(path.join(source, relative)));
bridge = bridge.replace(/const transportOnlyBuildHash = '[a-f0-9]+';/, `const transportOnlyBuildHash = '${buildHash.digest('hex')}';`);
for (const relative of files) {
  fs.mkdirSync(path.dirname(path.join(target, relative)), {recursive: true});
  fs.copyFileSync(path.join(source, relative), path.join(target, relative));
}
fs.writeFileSync(bridgePath, bridge);
fs.writeFileSync(wrapperPath, wrapper);
console.log('Scoped group extension prepared; no services started.');
