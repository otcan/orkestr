import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedBytes} from './saved-bytes.mjs';
import {clickReady, composerReady} from './readiness.mjs';

const EXPECTED = Buffer.from([0, 255, 128, 1, 13, 10, 65, 66, 0, 99]);
const FILENAME = 'synthetic-copy.bin';
const text = (page, expected) => page.waitForFunction(expected =>
  document.body.innerText.includes(expected), {timeout: 10_000}, expected);

// Same fixed binary-copy sequence as the qualified attachment fixture. The
// adapter, helper destination, context and download identity remain trusted
// composition inputs; this module accepts no caller-selected filesystem path.
export async function attachmentRoundtrip({page, adapter, verifyLease}) {
  assert.equal(typeof verifyLease, 'function');
  assert.equal(await verifyLease(), true, 'current_lease_required');
  await composerReady(page);
  await text(page, 'Files refreshed.');
  await page.$eval('section[aria-label="Thread files"] input[type=file]:not([accept])',
    (input, {bytes, filename}) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], filename));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }, {bytes: [...EXPECTED], filename: FILENAME});
  await clickReady(page, 'Save file copy');
  await text(page, 'File copy saved.');
  await page.reload({waitUntil: 'domcontentloaded', timeout: 15_000});
  await composerReady(page);
  await text(page, 'Files refreshed.');
  await clickReady(page, 'Open saved copy: synthetic-copy.bin');
  assert.equal(await verifyLease(), true, 'current_lease_required');
  const proof = await savedBytes({adapter, expected: EXPECTED, filename: FILENAME,
    click: () => clickReady(page, 'Verify and download')});
  assert.equal(await verifyLease(), true, 'current_lease_required');
  return {name: 'upload_reload_download_exact_saved_bytes_delete', bytes: proof.bytes.length,
    sha256: createHash('sha256').update(proof.bytes).digest('hex'),
    completion: proof.completion, deletion: proof.deletion};
}
