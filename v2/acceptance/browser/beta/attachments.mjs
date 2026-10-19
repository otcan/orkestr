import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedBytes} from './saved-bytes.mjs';
import {actionBoundary, clickReady, composerReady} from './readiness.mjs';

const EXPECTED = Buffer.from([0, 255, 128, 1, 13, 10, 65, 66, 0, 99]);
const FILENAME = 'synthetic-copy.bin';
const text = (page, expected) => page.waitForFunction(expected =>
  document.body.innerText.includes(expected), {timeout: 10_000}, expected);

// Same fixed binary-copy sequence as the qualified attachment fixture. The
// adapter, helper destination, context and download identity remain trusted
// composition inputs; this module accepts no caller-selected filesystem path.
export async function attachmentRoundtrip({page, adapter, verifyLease, origin, signal, diagnostics}) {
  const action = {signal, verify: verifyLease};
  const step = diagnostics?.step ?? (() => {});
  assert.equal(new URL(origin).origin, origin);
  assert.equal(typeof verifyLease, 'function');
  assert.equal(await verifyLease(), true, 'current_lease_required');
  step('initial_files');
  await composerReady(page);
  await text(page, 'Files refreshed.');
  step('upload_input');
  await actionBoundary(action);
  await page.$eval('section[aria-label="Thread files"] input[type=file]:not([accept])',
    (input, {bytes, filename, origin}) => {
      if (location.origin !== origin) throw Error('unexpected_origin');
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], filename));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }, {bytes: [...EXPECTED], filename: FILENAME, origin});
  step('upload_commit');
  await clickReady(page, 'Save file copy', origin, undefined, action);
  await text(page, 'File copy saved.');
  step('upload_confirmed');
  step('reload');
  const response = await page.reload({waitUntil: 'domcontentloaded', timeout: 15_000});
  assert(response && new URL(response.url()).origin === origin && new URL(page.url()).origin === origin);
  step('reloaded_files');
  await composerReady(page);
  await text(page, 'Files refreshed.');
  step('open_saved_copy');
  await clickReady(page, 'Open saved copy: synthetic-copy.bin', origin, undefined, action);
  assert.equal(await verifyLease(), true, 'current_lease_required');
  const proof = await savedBytes({adapter, expected: EXPECTED, filename: FILENAME, step,
    click: () => clickReady(page, 'Verify and download', origin, undefined, action)});
  step('final_lease');
  assert.equal(await verifyLease(), true, 'current_lease_required');
  return {name: 'upload_reload_download_exact_saved_bytes_delete', bytes: proof.bytes.length,
    sha256: createHash('sha256').update(proof.bytes).digest('hex'),
    completion: proof.completion, deletion: proof.deletion};
}
