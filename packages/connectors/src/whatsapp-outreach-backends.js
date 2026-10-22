import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {whatsappWorkerHealth, whatsappWorkerSend} from './whatsapp-worker-client.js';

// Calls the EXISTING authorized coordinator wrapper, with text on stdin and no
// shell. Only the protected service can invoke this backend; the scoped client
// receives a different credential and never the coordinator token or its path.
export function coordinatorCliBackend(command) {
  if (typeof command !== 'string' || !command.startsWith('/')) throw new Error('outreach_backend_invalid');
  function call(args, text = '') {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {stdio: ['pipe', 'pipe', 'ignore'],
        env: {PATH: '/usr/local/bin:/usr/bin:/bin'}, timeout: 130_000, killSignal: 'SIGKILL'});
      let output = '', overflow = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => {
        output += data;
        if (Buffer.byteLength(output) > 65_536) {overflow = true; child.kill('SIGKILL');}
      });
      child.once('error', () => reject(new Error('outreach_backend_failed')));
      child.stdin.on('error', () => {});
      child.once('close', code => {
        if (code !== 0 || overflow) return reject(new Error('outreach_backend_failed'));
        try {resolve(JSON.parse(output));} catch {reject(new Error('outreach_backend_failed'));}
      });
      child.stdin.end(text);
    });
  }
  return {health: () => call(['health']),
    send: request => call(['send', request.to, '-', '--request-id', request.requestId], request.text)};
}

// Reuses the existing worker and its own durable send journal. This backend does
// not start/reconnect an account and cannot replace a session. The private config
// fixes its account/socket; caller-controlled URLs/env/attachments are absent.
export function nativeOutreachBackend({socketPath, accountId, tokenFile}) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || !accountId) throw new Error('outreach_backend_invalid');
  // The private launcher validates this protected credential mount. It is used
  // only inside the service, never returned to a caller or passed to the CLI.
  const env = {ORKESTR_WA_WORKER_SOCKET: socketPath,
    ...(tokenFile ? {ORKESTR_WA_WORKER_TOKEN: fs.readFileSync(tokenFile, 'utf8').trim()} : {})};
  if (tokenFile && !env.ORKESTR_WA_WORKER_TOKEN) throw new Error('outreach_backend_invalid');
  return {
    async health() {
      const result = await whatsappWorkerHealth(env);
      const accounts = Array.isArray(result.accounts) ? result.accounts : [];
      const account = accounts.find(value => (value.accountId || value.id) === accountId);
      const ready = account?.ready === true && account?.authenticated === true;
      // The worker's existing scoped send policy independently compares the live
      // WhatsApp identity to its protected ownChatId before every actual send.
      return {ready, identityMatches: ready};
    },
    send: request => whatsappWorkerSend({accountId, conversationId: request.to, text: request.text,
      requestId: request.requestId, threadId: request.threadId}, env),
  };
}
