#!/usr/bin/env python3
"""Prepare independent exact-source Rust Store and validator probes; synthetic only.

No Cargo is invoked. An admitted caller installs the emitted Rust test files and fixture as a
store-sqlite integration test in a disposable archive of --revision, then runs
that actual implementation. Fixture checks alone are not Rust validator results,
Store tests exercise actual persisted ports; neither qualifies HTTP or live migration.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

PIN = '9cd9268234f52581de260681bf926be9d77968ef'
SOURCE_PATHS = ('v2/crates/contracts/src/attachments.rs',
                'v2/crates/store-sqlite/src/attachment_integrity.rs',
                'v2/crates/contracts/src/attachment_transfer.rs',
                'v2/crates/store-sqlite/migrations/0038_attachments.sql',
                'v2/crates/store-sqlite/src/attachment_store/mod.rs',
                'v2/crates/store-sqlite/src/attachment_store/read.rs',
                'v2/crates/store-sqlite/src/attachment_store/write.rs')
BLOBS = (b'', bytes((0,255,128,10,13,0)), b'same\r\nbytes\n', b'same\r\nbytes\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', type=Path, required=True)
    parser.add_argument('--revision', default=PIN)
    parser.add_argument('--emit-directory', type=Path, required=True)
    args = parser.parse_args()
    def show(revision, path):
        return subprocess.check_output(['git','-C',str(args.checkout),'show',f'{revision}:{path}'])
    # A successor may be selected, but the reviewed attachment implementation must be byte-exact.
    hashes = {}
    for path in SOURCE_PATHS:
        actual = show(args.revision,path)
        if actual != show(PIN,path):
            raise ValueError('reviewed validator source changed: '+path)
        hashes[path] = hashlib.sha256(actual).hexdigest()
    root = Path(__file__).resolve().parents[1]/'fixtures/migration-audit/attachments'
    raw = (root/'attachment-cases.json').read_bytes()
    m = json.loads(raw)
    if len(m['references']) != len(BLOBS) or len({r['reference_id'] for r in m['references']}) != len(BLOBS):
        raise ValueError('fixture reference cardinality changed')
    for r, data in zip(m['references'],BLOBS):
        uuid.UUID(r['reference_id'])
        if r['byte_length'] != len(data) or r['sha256'] != hashlib.sha256(data).hexdigest():
            raise ValueError('independent fixture length/digest mismatch')
    # Refuse overwrites or a nonempty destination; no checkout edits.
    args.emit_directory.mkdir(parents=True, exist_ok=False)
    source = (root/'validator_oracle.rs').read_bytes()
    (args.emit_directory/'attachment_integrity_oracle.rs').write_bytes(source)
    (args.emit_directory/'attachment-cases.json').write_bytes(raw)
    store_source = (root/'store_oracle.rs').read_bytes()
    (args.emit_directory/'attachment_store_oracle.rs').write_bytes(store_source)
    receipt = {'schema_version':1,'revision':args.revision,'source_sha256':hashes,
               'oracle_sha256':hashlib.sha256(source).hexdigest(),
               'fixture_sha256':hashlib.sha256(raw).hexdigest(),
               'fixture_vectors_checked':len(BLOBS),
               'store_oracle_sha256':hashlib.sha256(store_source).hexdigest(),
               'rust_validator_tests':'UNEXECUTED',
               'persisted_roundtrip':'UNEXECUTED: actual Store oracle emitted; no HTTP qualification'}
    (args.emit_directory/'preparation-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
