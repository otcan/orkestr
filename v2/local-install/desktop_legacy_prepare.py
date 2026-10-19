#!/usr/bin/env python3
"""Prepare fresh offline legacy evidence using a reviewed pinned Node source.

The Python seal function below is a compatibility oracle, never the CLI sealer.
"""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import re
import signal

from desktop_legacy_canonical import (ADOPTION_FORMAT, COHORT_FORMAT, MAX_SAFE,
                                      canonical, parse, retired_digest)
from desktop_legacy_io import prepare_bundle
from desktop_legacy_node import PinnedNodePreparer
from desktop_restore import MAX_BYTES, RecoveryError


def validate_legacy(state):
    if (not isinstance(state, dict) or 'lockIdentity' in state
            or 'legacyRetiredCohort' in state):
        raise RecoveryError('unadopted legacy object required')
    counter = state.get('fencingCounter')
    records = state.get('desktopLeases')
    if type(counter) not in (int, float) or counter != int(counter) or not 0 <= counter <= MAX_SAFE or not isinstance(records, list):
        raise RecoveryError('invalid legacy state')
    ids, active = set(), set()
    text = lambda x: isinstance(x, str) and bool(x) and x.strip() == x
    identifier = lambda x: text(x) and re.fullmatch('[a-z0-9_.-]+', x)
    maximum = counter
    for record in records:
        if not isinstance(record, dict):
            raise RecoveryError('invalid legacy record')
        version = record.get('fencingVersion')
        if (not all(text(record.get(k)) for k in ('id', 'threadId', 'fencingToken', 'acquiredAt', 'heartbeatAt'))
                or not all(identifier(record.get(k)) for k in ('ownerUserId', 'desktopSlug'))
                or record.get('mode') not in ('exclusive', 'viewOnly', 'sharedRead')
                or type(version) not in (int, float) or version != int(version)
                or not 1 <= version <= counter
                or any(k not in record for k in ('expiresAt', 'releasedAt'))
                or any(record.get(k) is not None and not text(record.get(k)) for k in ('expiresAt', 'releasedAt'))):
            raise RecoveryError('invalid legacy record')
        key = (record['ownerUserId'], record['desktopSlug'])
        if record['id'] in ids or (not record['releasedAt'] and key in active):
            raise RecoveryError('duplicate legacy identity or active owner')
        ids.add(record['id'])
        if not record['releasedAt']:
            active.add(key)
        maximum = max(maximum, version)
    if maximum >= MAX_SAFE - 1:
        raise RecoveryError('fresh generation and next acquisition require headroom')
    return int(maximum) + 1


def seal(raw, source_digest, *, revoked_at=None):
    if hashlib.sha256(raw).hexdigest() != source_digest:
        raise RecoveryError('source digest mismatch')
    original = parse(raw)
    floor = validate_legacy(original)
    state = copy.deepcopy(original)
    stamp = revoked_at or datetime.now(timezone.utc).isoformat()
    if not isinstance(stamp, str) or not stamp or stamp.strip() != stamp:
        raise RecoveryError('explicit revocation timestamp required')
    for record in state['desktopLeases']:
        if not record['releasedAt']:
            record.update(releasedAt=stamp, updatedAt=stamp,
                          releaseReason='legacy_history_retired')
    records = state['desktopLeases']
    cohort = dict(format=COHORT_FORMAT, sourceSha256=source_digest, generationFloor=floor,
                  retiredIds=sorted((row['id'] for row in records), key=lambda value: value.encode('utf-8')),
                  retiredSha256=retired_digest(source_digest, floor, records))
    state.update(fencingCounter=floor, legacyRetiredCohort=cohort)
    canonical(state)
    output = (json.dumps(state, ensure_ascii=True, indent=2, allow_nan=False) + '\n').encode()
    receipt = dict(format=ADOPTION_FORMAT, sourceSha256=source_digest,
                   preparedSha256=hashlib.sha256(output).hexdigest(), cohort=cohort)
    adoption = (json.dumps(receipt, ensure_ascii=True, indent=2, allow_nan=False) + '\n').encode()
    if max(len(output), len(adoption)) > MAX_BYTES:
        raise RecoveryError('prepared JSON exceeds bound')
    return output, adoption


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--source-sha256', required=True)
    parser.add_argument('--offline-source-confirmed', action='store_true')
    parser.add_argument('--validator-repository', required=True)
    parser.add_argument('--validator-commit', required=True)
    args = parser.parse_args()
    def interrupt(signum, frame):
        raise KeyboardInterrupt(f'interrupted by signal {signum}')
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)
    if not args.offline_source_confirmed:
        raise RecoveryError('explicit offline source confirmation required; age is not quiescence')
    preparer = PinnedNodePreparer(args.validator_repository, args.validator_commit)
    result = prepare_bundle(args.source, args.target, args.source_sha256, preparer,
                            offline_confirmed=True, provenance=preparer.provenance)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
