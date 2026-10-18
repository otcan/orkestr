#!/usr/bin/env python3
"""Explicit-path migration planning CLI; no dispatch or product apply command."""
import argparse
import json
import sys
from bundle_io import copy_bundle
from ledger_io import plan_to_file, recovery_export, recovery_restore
from snapshot import Invalid, load


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    validate = commands.add_parser('validate')
    validate.add_argument('snapshot')
    plan = commands.add_parser('plan')
    plan.add_argument('snapshot')
    plan.add_argument('ledger')
    export = commands.add_parser('ledger-export')
    export.add_argument('ledger')
    export.add_argument('archive')
    restore = commands.add_parser('ledger-restore')
    restore.add_argument('archive')
    restore.add_argument('ledger')
    for name in ('bundle-export', 'bundle-restore'):
        bundle = commands.add_parser(name)
        bundle.add_argument('source')
        bundle.add_argument('destination')
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            document = load(args.snapshot)
            result = {'counts': document['counts'], 'consistency': 'producer_assertion_only'}
        elif args.command == 'plan':
            result = plan_to_file(args.snapshot, args.ledger)
        elif args.command in {'bundle-export', 'bundle-restore'}:
            result = {'copied_inert_bundle': copy_bundle(args.source, args.destination)}
        elif args.command == 'ledger-export':
            recovery_export(args.ledger, args.archive)
            result = {'exported': 'inert_ledger_only'}
        else:
            recovery_restore(args.archive, args.ledger)
            result = {'restored': 'inert_ledger_only'}
        print(json.dumps({'ok': True, 'dispatch_allowed': False, 'result': result}, sort_keys=True))
        return 0
    except (Invalid, OSError, ValueError, TypeError, KeyError) as error:
        # Do not print private file paths, payloads, identities or exception values.
        code = str(error) if isinstance(error, Invalid) else 'invalid_input_or_io'
        print(json.dumps({'ok': False, 'code': code}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
