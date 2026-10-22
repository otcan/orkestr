import net from 'node:net';
import fs from 'node:fs';
import {outreachError} from './whatsapp-outreach-policy.js';

// Kernel-enforced singleton acquired BEFORE journal recovery. The path is derived
// from the journal, so a second listener/config cannot open the same database.
// An unclean exit leaves a stale lease socket: fail closed for operator review,
// never unlink a socket just because another instance wants to start.
export async function acquireOutreachLease(journalPath) {
  const socketPath = `${journalPath}.lease`;
  const server = net.createServer(connection => connection.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(outreachError('journal_busy', 409)));
    server.listen(socketPath, resolve);
  });
  return {async close() {
    await new Promise(resolve => server.close(resolve));
    // Node normally removes a Unix listener on close. Never unlink an unknown
    // replacement path or create a window for two database owners.
    if (fs.existsSync(socketPath)) throw outreachError('lease_cleanup_required');
  }};
}
