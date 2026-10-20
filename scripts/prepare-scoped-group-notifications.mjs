// Upgrade only an inactive copy of an existing scoped group runtime. No services,
// credentials or session data are read or changed by this preparation helper.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const target=process.argv[2];
if(!target)throw new Error('usage: prepare-scoped-group-notifications.mjs <inactive-copy>');
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wrapperPath=path.join(target,'scripts/account-wrapper.mjs');
let wrapper=fs.readFileSync(wrapperPath,'utf8');
const replacements=[
 ["'group-meta','group-reply']","'group-meta','group-reply','group-notify']"],
 ["if(command==='group-reply')","if(command==='group-reply' || command==='group-notify')"],
 ["JSON.stringify({to,text,accountId:'main',requestId,parentId})","JSON.stringify({to,text,accountId:'main',requestId,parentId,...(command==='group-notify'?{notificationId:requestId}:{})})"],
];
for(const [from,to] of replacements){if(wrapper.split(from).length!==2)throw new Error('notification_wrapper_source_mismatch');wrapper=wrapper.replace(from,to);}
const modules=['whatsapp-scoped-group-relay','whatsapp-scoped-group-formatting','whatsapp-scoped-group-transport','whatsapp-group-owner-author','whatsapp-scoped-timer-notifications','whatsapp-scoped-remote-timer-replies','whatsapp-timer-notification-proof','whatsapp-delivery-route-fence'];
const files=[...modules.map(m=>`packages/connectors/src/${m}.js`),'scripts/scoped-group-relay.mjs','apps/cli/src/api-client.js'];
const bridgePath=path.join(target,'scripts/wa_web_bridge.mjs');
let bridge=fs.readFileSync(bridgePath,'utf8');
if(!bridge.includes('createScopedGroupTransport'))throw new Error('notification_bridge_source_mismatch');
const hash=crypto.createHash('sha256').update(bridge.replace(/const transportOnlyBuildHash = '[a-f0-9]+';/,'')).update(wrapper);
for(const f of files)hash.update(fs.readFileSync(path.join(source,f)));
if(!/const transportOnlyBuildHash = '[a-f0-9]+';/.test(bridge))throw new Error('notification_build_hash_missing');
bridge=bridge.replace(/const transportOnlyBuildHash = '[a-f0-9]+';/,`const transportOnlyBuildHash = '${hash.digest('hex')}';`);
for(const f of files){const out=path.join(target,f);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(source,f),out);}
fs.writeFileSync(wrapperPath,wrapper);fs.writeFileSync(bridgePath,bridge);
console.log('Notification runtime prepared inactive; no services or permissions changed.');
