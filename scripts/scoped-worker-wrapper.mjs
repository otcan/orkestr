// Private operator config selects the existing native worker, never a new login.
import fs from 'node:fs';
import {requestWhatsAppWorker} from '../packages/connectors/src/whatsapp-worker-client.js';
const config=JSON.parse(fs.readFileSync(process.env.ORKESTR_WA_SCOPED_GROUP_CONFIG,'utf8'));
const [command,to,requestId,parentId,...parts]=process.argv.slice(2);
if(!['group-reply','group-notify'].includes(command) || config.groups?.length!==1 || config.groups[0].chatId!==to || !requestId || !parentId || !parts.length)
 throw new Error('scoped_worker_wrapper_scope_denied');
const result=await requestWhatsAppWorker('/send-text',{method:'POST',body:{accountId:config.workerAccountId,to,text:parts.join(' '),requestId,parentId,...(command==='group-notify'?{notificationId:requestId}:{})}});
console.log(JSON.stringify(result));
