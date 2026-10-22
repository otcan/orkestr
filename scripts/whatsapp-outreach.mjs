#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {requestOutreach} from '../packages/connectors/src/whatsapp-outreach-client.js';
import {acquireOutreachLease} from '../packages/connectors/src/whatsapp-outreach-lease.js';
import {outreachPolicy} from '../packages/connectors/src/whatsapp-outreach-policy.js';
import {openOutreachJournal} from '../packages/connectors/src/whatsapp-outreach-journal.js';
import {createOutreachSender} from '../packages/connectors/src/whatsapp-outreach-sender.js';
import {createOutreachHttpServer} from '../packages/connectors/src/whatsapp-outreach-http.js';
import {coordinatorCliBackend, nativeOutreachBackend} from '../packages/connectors/src/whatsapp-outreach-backends.js';

// Config, grant hashes, runtime state, recipient lists and journals are PRIVATE
// overlay data, never checked into the product. This entry point does not install
// itself, modify routing or pair an account. Acquire the exclusive journal lease
// before opening SQLite, including during an offline baseline import.
const [mode, configPath] = process.argv.slice(2);
function protectedPath(value, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('outreach_path_invalid');
  for (let current = value;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) || stat.uid !== 0
        || (current === value && (directory ? !stat.isDirectory() : !stat.isFile())))
      throw new Error('outreach_path_unprotected');
    if (current === '/') return;
  }
}
function readConfig() {
  protectedPath(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  protectedPath(path.dirname(config.journalPath), true);
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(config.journalPath + suffix)) protectedPath(config.journalPath + suffix);
  protectedPath(path.dirname(config.socketPath), true);
  protectedPath(config.controlPath);
  return config;
}
try {
  if (['serve', 'import-baseline', 'reconcile'].includes(mode)) {
    const config = readConfig();
    const policy = outreachPolicy(config.policy);
    process.umask(0o077);
    const lease = await acquireOutreachLease(config.journalPath);
    let journal, server;
    try {
      journal = openOutreachJournal(config.journalPath, policy);
      if (mode === 'reconcile') {
        const evidencePath = process.argv[4]; protectedPath(evidencePath);
        process.stdout.write(JSON.stringify(journal.reconcile(JSON.parse(fs.readFileSync(evidencePath, 'utf8')), Date.now())) + '\n');
      } else if (mode === 'import-baseline') {
        // Offline only, under the SAME kernel lease as serve; no listener or send backend.
        const baselinePath = process.argv[4]; protectedPath(baselinePath);
        journal.importBaseline(JSON.parse(fs.readFileSync(baselinePath, 'utf8')));
        process.stdout.write(JSON.stringify({ok: true, ...journal.status(Date.now())}) + '\n');
      } else {
        const backends = Object.create(null);
        for (const accountId of policy.accounts) {
          const backend = config.backends?.[accountId];
          if (backend?.kind === 'coordinator-cli') {
            protectedPath(backend.command);
            backends[accountId] = coordinatorCliBackend(backend.command);
          } else if (backend?.kind === 'native-worker') {
            if (backend.tokenFile) protectedPath(backend.tokenFile);
            backends[accountId] = nativeOutreachBackend(backend);
          }
          else throw new Error('outreach_backend_invalid');
        }
        const state = () => {protectedPath(config.controlPath); return JSON.parse(fs.readFileSync(config.controlPath, 'utf8'));};
        const sender = createOutreachSender({policy, journal, backends, state});
        server = createOutreachHttpServer({policy, sender, grants: config.grants});
        // Never unlink an unknown socket or disturb another live process. The
        // operator must verify no process owns a stale socket before removing it.
        process.umask(0o077);
        await new Promise((resolve, reject) => {server.once('error', reject); server.listen(config.socketPath, resolve);});
        // Only the operator-selected service group can reach the socket; account-
        // specific bearer authorization is still required for every operation.
        fs.chmodSync(config.socketPath, 0o660);
        process.stdout.write(JSON.stringify({ok: true, event: 'listening', contract: policy.fingerprint}) + '\n');
        await new Promise(resolve => {
          const stop = () => server.close(resolve);
          process.once('SIGTERM', stop); process.once('SIGINT', stop);
        });
      }
    } finally {
      // Startup failure after listen (for example socket chmod) must not leave
      // an orphan listener serving against a closed journal.
      try {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        journal?.close();
      } finally {await lease.close();}
    }
  } else if (mode === 'status' || mode === 'send-text' || mode === 'receipt') {
    // Scoped bearer supplied by the supported per-thread secret injection path;
    // no coordinator token file, owner session file or unrestricted CLI here.
    const body = mode === 'send-text' ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
    const receiptId = mode === 'receipt' ? configPath : '';
    if (mode === 'receipt' && !/^[A-Za-z0-9:._-]{1,160}$/.test(receiptId || '')) throw new Error('outreach_request_invalid');
    const result = await requestOutreach(mode === 'send-text' ? '/send-text' : mode === 'receipt' ? `/receipts/${receiptId}` : '/health',
      {method: mode === 'send-text' ? 'POST' : 'GET', body});
    process.stdout.write(JSON.stringify(result.body) + '\n');
    process.exitCode = result.status === 200 ? 0 : 1;
  } else throw new Error('usage: whatsapp-outreach.mjs serve|import-baseline|reconcile CONFIG [EVIDENCE] | status | receipt REQUEST_ID | send-text');
} catch (error) {
  process.stderr.write(/^outreach_[a-z_]+$/.test(error?.message || '') ? error.message + '\n' : 'outreach_start_failed\n');
  process.exitCode = 1;
}
