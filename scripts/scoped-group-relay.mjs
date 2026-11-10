import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requestJson} from '../apps/cli/src/api-client.js';
import {createScopedGroupRelay} from '../packages/connectors/src/whatsapp-scoped-group-relay.js';

const execute = promisify(execFile);
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const formatter = config.appendDebugFooter === true
  ? await import(config.formattingModulePath || '../packages/connectors/src/whatsapp-formatting.js') : null;
const log = event => console.log(JSON.stringify(event));
const relay = createScopedGroupRelay({
  config,
  formatter,
  api: (url, options = {}) => requestJson(url, {timeoutMs: 15000, ...options}),
  send: async ({chatId, requestId, parentId, text}) => {
    const {stdout} = await execute('/usr/bin/node', [config.wrapperPath, 'group-reply', chatId, requestId, parentId, text],
      {timeout: 45000, maxBuffer: 1024 * 1024});
    return JSON.parse(stdout);
  },
  log,
});
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopped = true; });
log({event: 'group_relay_started', groups: config.groups.length});
while (!stopped) {
  const status = await relay.tick();
  if (config.statusPath) {
    fs.writeFileSync(`${config.statusPath}.tmp`, JSON.stringify({...status, checkedAt: new Date().toISOString()}), {mode: 0o600});
    fs.renameSync(`${config.statusPath}.tmp`, config.statusPath);
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
relay.close();
