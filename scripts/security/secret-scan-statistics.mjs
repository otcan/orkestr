import {spawn, spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Retain only the two numeric columns. Paths can be long and are never kept,
// printed or used as a reason to truncate the requested history.
export class AdditionCounter {
  prefix = '';
  skipPath = false;
  additions = 0;
  feed(chunk) {
    for (let at = 0; at < chunk.length;) {
      if (this.skipPath) {
        const newline = chunk.indexOf(10, at);
        if (newline < 0) return;
        at = newline + 1;
        this.skipPath = false;
        continue;
      }
      const byte = chunk[at++];
      if (byte === 10) {
        if (this.prefix) throw new Error('scan_revision_count_invalid');
        continue;
      }
      this.prefix += String.fromCharCode(byte);
      if (this.prefix.length > 64) throw new Error('scan_revision_count_invalid');
      const match = this.prefix.match(/^(\d+|-)\t(\d+|-)\t$/);
      if (!match) continue;
      if (match[1] !== '-') this.additions += Number(match[1]);
      if (!Number.isSafeInteger(this.additions)) throw new Error('scan_revision_count_invalid');
      this.prefix = '';
      this.skipPath = true;
    }
  }
  finish() {
    if (this.prefix) throw new Error('scan_revision_count_invalid');
    return this.additions;
  }
}

// A synchronous, tiny result preserves resolveScope's API. The helper streams
// Git output with constant retained metadata rather than buffering all numstat.
export function historyAdditions(repository, logOptions, env) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), repository, ...logOptions.split(' ')],
    {env, encoding: 'utf8', timeout: 35000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore']});
  if (result.status !== 0 || result.error) throw new Error('scan_revision_count_invalid');
  let value;
  try {value = JSON.parse(result.stdout);} catch {throw new Error('scan_revision_count_invalid');}
  if (!value || Object.keys(value).join() !== 'scannableAddedLines' ||
      !Number.isSafeInteger(value.scannableAddedLines) || value.scannableAddedLines < 0)
    throw new Error('scan_revision_count_invalid');
  return value.scannableAddedLines;
}

async function main() {
  const [repository, ...options] = process.argv.slice(2);
  const fixed = ['--full-history', '--diff-merges=separate', '--no-ext-diff', '--no-textconv'];
  const revisions = options.slice(fixed.length);
  const commit = '(?:[a-f0-9]{40}|[a-f0-9]{64})';
  const revision = new RegExp(`^${commit}(?:\\.\\.${commit})?$`);
  if (!path.isAbsolute(repository || '') || options.slice(0, fixed.length).join() !== fixed.join() ||
      !revisions.length || revisions.length > 100 || !revisions.every(ref => revision.test(ref)) ||
      (revisions.some(ref => ref.includes('..')) && revisions.length !== 1))
    throw new Error('explicit_scan_scope_required');
  const counter = new AdditionCounter();
  const child = spawn('git', ['--no-replace-objects', '-C', repository, 'log', '--format=', '--numstat', ...options, '--'],
    {env: process.env, stdio: ['ignore', 'pipe', 'ignore']});
  let failed = false;
  const stop = () => {failed = true; child.kill('SIGKILL');};
  const deadline = setTimeout(stop, 30000);
  process.once('SIGTERM', stop);
  child.stdout.on('data', chunk => {try {counter.feed(chunk);} catch {stop();}});
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    if (failed || status !== 0) throw new Error('scan_revision_count_invalid');
    console.log(JSON.stringify({scannableAddedLines: counter.finish()}));
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await main();} catch {console.error('scan_revision_count_invalid'); process.exitCode = 1;}
}
