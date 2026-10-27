import fs from 'node:fs';
import path from 'node:path';
import {startScopedRemoteWatch} from '../packages/connectors/src/whatsapp-scoped-remote-watch.js';
import {createKeyedSerial} from '../packages/connectors/src/scoped-relay-serial.js';
import {execFile} from 'node:child_process';
import {requestJson} from '../apps/cli/src/api-client.js';
import {createScopedTimerNotifications} from '../packages/connectors/src/whatsapp-scoped-timer-notifications.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';
import {createInputJournalWake} from '../packages/connectors/src/scoped-group-input-intake.js';
import {wrapperRejection} from '../packages/connectors/src/whatsapp-scoped-wrapper-errors.js';

// A text keeps the wrapper's argv contract. A reply document, or a text too
// large for one argument (Linux allows 128 KiB), goes as JSON on stdin, as does
// a text that quotes the input it answers (`quotedMessageId`).
const ARGV_TEXT_MAX_BYTES = 100_000;
const serializeTransport = createKeyedSerial();
const execute = payload => serializeTransport('transport', () => new Promise((resolve, reject) => {
  const viaArgv = payload.document === undefined && payload.file === undefined && payload.quotedMessageId === undefined && Buffer.byteLength(payload.text || '') <= ARGV_TEXT_MAX_BYTES;
  const args = viaArgv
    ? [config.wrapperPath, payload.kind === 'notify' ? 'group-notify' : 'group-reply', payload.to, payload.requestId, payload.parentId, payload.text]
    : [config.wrapperPath, 'group-send'];
  const child = execFile('/usr/bin/node', args, {timeout: payload.file ? 130000 : 45000, maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, {stdout, stderr}));
    else resolve({stdout, stderr});
  });
  child.stdin.on('error', () => {});
  child.stdin.end(viaArgv ? '' : JSON.stringify(payload));
}));
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const formatter = config.appendDebugFooter === true
  ? await import(config.formattingModulePath || '../packages/connectors/src/whatsapp-formatting.js') : null;
const log = event => console.log(JSON.stringify(event));
const relay = createScopedGroupRelay({
  config,
  formatter,
  api: (url, options = {}) => requestJson(url, {timeoutMs: 15000, ...options}),
  send: async ({chatId, requestId, parentId, text, document, file}) => {
    const {stdout} = await execute({kind: 'reply', to: chatId, requestId, parentId, text, document, file});
    return JSON.parse(stdout);
  },
  log,
});
const notifications = createScopedTimerNotifications({config,formatter,minIntervalMs:10000,
  api:(url,options={})=>requestJson(url,{timeoutMs:15000,...options}),
  send:async({chatId,requestId,parentId,text,document,quotedMessageId})=>{
    try {
      const {stdout}=await execute({kind:'notify',to:chatId,requestId,parentId,text,document,...(quotedMessageId?{quotedMessageId}:{})});
      return JSON.parse(stdout);
    } catch (error) {
      throw wrapperRejection(error);
    }
  },
});
const remoteWatch = startScopedRemoteWatch({
  api: (url, options = {}) => requestJson(url, options), log,
  deliver: async threadIds => {
    const result = await relay.deliverThreads(threadIds);
    if (!result.ok) throw new Error('remote_relay_delivery_blocked');
    const notificationsResult = await notifications.tick({threadIds});
    if (notificationsResult.errors && Object.keys(notificationsResult.errors).length) throw new Error('remote_notification_delivery_failed');
  },
});
const intakeWake = createInputJournalWake({admit: options => relay.admitNewInputs(options), log});
// SQLite WAL writes wake new text admission as well as deadline scheduling,
// independently of unrelated reply scans or transport sends.
const journalWatch = config.journalPath ? fs.watch(path.dirname(config.journalPath), (_event, filename) => {
  if (!filename || String(filename).startsWith(path.basename(config.journalPath))) {
    relay.scheduleAcknowledgements();
    intakeWake.signal();
  }
}) : null;
relay.scheduleAcknowledgements();
intakeWake.signal();
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopped = true; });
log({event: 'group_relay_started', groups: config.groups.length});
while (!stopped) {
  const status = await relay.tick();
  // An unrelated inactive binding must not starve this thread's notifications.
  // A global unresolved transport delivery still stops every send.
  if(!status.error) {
    try {status.timerNotifications=await notifications.tick();}
    catch(e){status.timerNotifications={ok:false,error:/^[a-z_]+$/.test(e.message)?e.message:'notification_operation_failed'};}
  }
  if (config.statusPath) {
    fs.writeFileSync(`${config.statusPath}.tmp`, JSON.stringify({...status, checkedAt: new Date().toISOString()}), {mode: 0o600});
    fs.renameSync(`${config.statusPath}.tmp`, config.statusPath);
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
journalWatch?.close();
await intakeWake.close();
await remoteWatch.close();
relay.close();
notifications.close();
