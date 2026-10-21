#!/usr/bin/env python3
"""Per-thread V1 <-> V2 history moves. Explicit paths only; dry-run by default.

  v1-export   consistent read-only V1 snapshot of selected threads -> private bundle
  v2-import   bundle thread -> V2 conversation archived history (delta, idempotent)
  v2-status   archived-history cursors/counts/checksums for a conversation
  v2-export   V2-era conversation messages -> private rollback archive
  v1-append   rollback archive -> inert archived rows on a migrated V1 sqlite thread
  v2-lineage  record V1 lineage (source thread, V1 parent) of imported conversations

Output is a JSON report of counts, identifiers and checksums; message text,
credentials and private paths are never printed.
"""
import argparse
import json
from pathlib import Path
import sys

# Isolated mode (-I) omits the script directory; add only this reviewed directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import history_import  # noqa: E402
import lineage  # noqa: E402
import v1_export  # noqa: E402
import v2_client  # noqa: E402
import v2_rollback  # noqa: E402


def _client(args):
    username, password = v2_client.read_credentials(args.credentials_file)
    client = v2_client.Client(args.v2_url, origin=args.origin)
    client.login(username, password)
    return client


def _with_client(args, action):
    client = _client(args)
    try:
        return action(client)
    finally:
        client.close()


def _v1_export(args):
    manifest = v1_export.export(args.v1_home, args.thread, args.out, args.source_instance,
                                include_unsettled=args.include_unsettled,
                                settle_window=args.settle_window_seconds, keep_backups=args.keep_backups)
    hidden = {'quarantined_ids', 'directory', 'legacy_json'}
    return {'snapshot_id': manifest['snapshot_id'], 'consistency': manifest['consistency'],
            'threads': [{k: v for k, v in t.items() if k not in hidden} |
                        {'legacy_json': {k: v for k, v in (t['legacy_json'] or {}).items() if k != 'file'} or None}
                        for t in manifest['threads']]}


def _v2_import(args):
    manifest, messages = v1_export.load(args.bundle)
    return _with_client(args, lambda client: history_import.import_thread(
        client, manifest, messages, args.thread, conversation=args.conversation,
        create_name=args.create_name, apply=args.apply))


def _v2_status(args):
    return _with_client(args, lambda client: client.get(
        f'/api/v2/conversations/{args.conversation}/archived-history/status'))


def _v2_export(args):
    def run(client):
        archive = v2_rollback.export_conversation(client, args.conversation, args.after_sequence)
        v2_rollback.write_archive(archive, args.out)
        return {'conversation_id': archive['conversation_id'], 'entries': len(archive['entries']),
                'after_sequence': archive['after_sequence'], 'watermark': archive['watermark'],
                'digest': archive['digest'],
                'text_unavailable': sum(not e['text_available'] for e in archive['entries'])}
    return _with_client(args, run)


def _v2_lineage(args):
    return _with_client(args, lambda client: lineage.backfill(
        client, args.v1_home, args.source_instance, args.conversation, apply=args.apply))


def _v1_append(args):
    return v2_rollback.append_to_v1(v2_rollback.read_archive(args.archive), args.v1_db,
                                    args.thread, apply=args.apply)


def parser():
    root = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest='command', required=True)

    def remote(command):
        command.add_argument('--v2-url', required=True)
        command.add_argument('--origin', help='server origin when it differs from --v2-url')
        command.add_argument('--credentials-file', required=True,
                             help='private 0600 JSON {"username","password"}')

    export = commands.add_parser('v1-export')
    export.add_argument('--v1-home', required=True)
    export.add_argument('--thread', action='append', required=True)
    export.add_argument('--out', required=True)
    export.add_argument('--source-instance', default='orkestr-v1')
    export.add_argument('--include-unsettled', action='store_true')
    export.add_argument('--settle-window-seconds', type=int, default=86400)
    export.add_argument('--keep-backups', action='store_true')
    export.set_defaults(run=_v1_export)

    imp = commands.add_parser('v2-import')
    imp.add_argument('--bundle', required=True)
    imp.add_argument('--thread', required=True)
    target = imp.add_mutually_exclusive_group(required=True)
    target.add_argument('--conversation')
    target.add_argument('--create-name')
    imp.add_argument('--apply', action='store_true')
    remote(imp)
    imp.set_defaults(run=_v2_import)

    status = commands.add_parser('v2-status')
    status.add_argument('--conversation', required=True)
    remote(status)
    status.set_defaults(run=_v2_status)

    out = commands.add_parser('v2-export')
    out.add_argument('--conversation', required=True)
    out.add_argument('--out', required=True)
    out.add_argument('--after-sequence', type=int, default=0)
    remote(out)
    out.set_defaults(run=_v2_export)

    lineage_command = commands.add_parser('v2-lineage')
    lineage_command.add_argument('--v1-home', required=True, help='V1 home; threads.sqlite is read-only')
    lineage_command.add_argument('--source-instance', required=True)
    lineage_command.add_argument('--conversation', action='append',
                                 help='limit to these conversations (default: all)')
    lineage_command.add_argument('--apply', action='store_true')
    remote(lineage_command)
    lineage_command.set_defaults(run=_v2_lineage)

    append = commands.add_parser('v1-append')
    append.add_argument('--archive', required=True)
    append.add_argument('--v1-db', required=True, help='explicit V1 thread-messages.sqlite')
    append.add_argument('--thread', required=True)
    append.add_argument('--apply', action='store_true')
    append.set_defaults(run=_v1_append)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        result = args.run(args)
    except (v1_export.ExportError, v2_rollback.RollbackError) as error:
        print(json.dumps({'ok': False, 'code': str(error)}), file=sys.stderr)
        return 2
    except v2_client.ApiError as error:
        print(json.dumps({'ok': False, 'code': error.code, 'status': error.status}), file=sys.stderr)
        return 2
    except (OSError, ValueError, KeyError, TypeError) as error:
        # No paths, payloads or exception text: they may contain private data.
        print(json.dumps({'ok': False, 'code': type(error).__name__}), file=sys.stderr)
        return 2
    print(json.dumps({'ok': True, 'result': result}, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
