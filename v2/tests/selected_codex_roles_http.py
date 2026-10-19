"""Explicit root-only synthetic qualification of the public two-role composition.

Build/stage a protected server from the exact committed source, then pass that
binary, --source SHA and --report path. Every account file is a new dummy fixture.
No provider login, real executable, HTTPS request or installed service is used.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

from selected_codex_roles_case import SelectedRolesCase
from owned_fast_http import (independent_presentations, both_roles_restart, fast_stop_preserves_deep,
                             ack_is_unknown, revocation_fences_both)


def run(args, records):
    for scenario in (independent_presentations, both_roles_restart, fast_stop_preserves_deep,
                     ack_is_unknown, revocation_fences_both):
        case = SelectedRolesCase(args.source)
        record = {'case':scenario.__name__, 'fixture':str(case.root), 'passed':False}
        records.append(record)
        started = time.monotonic()
        try:
            case.setup()
            scenario(case)
            record.update(ledger=case.ledger(), trace=case.trace(), package=case.receipt, passed=True)
        except BaseException as error:
            record['error'] = type(error).__name__ + ': ' + str(error)
            raise
        finally:
            try:
                case.cleanup()
                record['cleanup'] = {'all_recorded_identities_gone':True, 'endpoint_and_listener_absent':True,
                                     'processes':list(case.known.values()), 'fixture_retained_for_review':True}
                if case.runtime:
                    record['aggregate_budget'] = case.runtime.snapshot()
            except BaseException as error:
                record['passed'] = False
                record['cleanup_error'] = type(error).__name__ + ': ' + str(error)
                raise
            finally:
                record['elapsed_seconds'] = round(time.monotonic() - started, 3)
                with (case.root / 'receipt.json').open('x') as stream:
                    json.dump(record, stream, indent=2);stream.write('\n')
                (case.root / 'receipt.json').chmod(0o600)
        print(json.dumps({key:record[key] for key in ('case','passed','elapsed_seconds','fixture')}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--source', required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    records = []
    try:
        run(args, records)
    finally:
        with args.report.open('x') as stream:
            json.dump({'source':args.source, 'binary_sha256':hashlib.sha256(args.binary.read_bytes()).hexdigest(),
                       'provider':'fixed-synthetic-native-elf', 'account':'fresh-dummy-only', 'cases':records,
                       'actual_provider':False, 'full_release':False, 'actual_egress_traffic':False}, stream, indent=2)
            stream.write('\n')
        args.report.chmod(0o600)
