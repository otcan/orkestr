#!/usr/bin/env python3
"""Read-only executor reconciliation. Inputs are private; reports contain no message bodies."""
import argparse
import datetime
import glob
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile

UUID = re.compile(r"(?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])")


def load(path):
    return json.loads(Path(path).read_text())


def unique_homes(paths):
    return sorted({str(Path(p).resolve()) for p in paths})


def bindings(path):
    """Query only the binding projection; never open auth/session token tables."""
    uri = Path(path).resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        db.row_factory = sqlite3.Row
        return [dict(r) for r in db.execute(
            'SELECT conversation_id, role, provider_kind, native_session_id, '
            'generation, state FROM session_bindings WHERE state != ?', ('retired',))]


def proc_inventory(root='/proc'):
    rows = []
    for path in Path(root).glob('[0-9]*'):
        try:
            args = (path / 'cmdline').read_bytes().decode(errors='replace').split('\0')
            # Inspect argv for classification, but never retain it in reports.
            base = Path(args[0]).name if args else ''
            provider = 'claude' if 'claude' in base else 'codex' if 'codex' in base else None
            if not provider:
                continue
            status = (path / 'status').read_text().splitlines()
            ppid = int(next(s.split()[1] for s in status if s.startswith('PPid:')))
            native = None
            resume = 'resume' if provider == 'codex' else '--resume'
            if resume in args:
                native = next((a for a in args[args.index(resume) + 1:] if UUID.fullmatch(a)), None)
            if not native:
                # Read only supported identity keys, and do not retain other env values.
                for item in (path / 'environ').read_bytes().split(b'\0'):
                    key, _, value = item.partition(b'=')
                    if key == {'codex': b'CODEX_THREAD_ID', 'claude': b'CLAUDE_SESSION_ID'}[provider]:
                        candidate = value.decode(errors='replace')
                        if UUID.fullmatch(candidate):
                            native = candidate
            # Reading another thread's rollout is ordinary agent work. An open
            # transcript descriptor cannot establish this process's native ID.
            infrastructure = ('code-mode-host' in base or 'code_mode_host' in base or
                              any(a in ('app-server', 'daemon', 'code-mode') for a in args[1:]))
            start_ticks = (path / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            rows.append({'start_ticks': start_ticks, 'pid': int(path.name), 'ppid': ppid, 'provider': provider,
                         'native_session_id': native,
                         'kind': 'infrastructure' if infrastructure else 'executor',
                         'source': 'proc:identity-projection', 'process_observed': True})
        except (OSError, ValueError, StopIteration):
            continue
    return rows


def tmux_inventory(sockets):
    panes, errors = {}, []
    for socket in sorted(set(sockets)):
        try:
            out = subprocess.run(['tmux', '-S', socket, 'list-panes', '-a', '-F',
                                  '#{pane_id}\t#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}'],
                                 check=True, capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                pane, pid, view = line.split('\t')
                key = (socket, pane)
                row = panes.setdefault(key, {'socket': socket, 'pane': pane, 'pid': int(pid), 'views': []})
                if view not in row['views']:
                    row['views'].append(view)
        except (OSError, ValueError, subprocess.SubprocessError):
            errors.append({'source': socket, 'status': 'unavailable'})
    return list(panes.values()), errors


def transcript_inventory(homes):
    rows = {}
    for home in unique_homes(homes):
        patterns = [('codex', 'sessions/**/*.jsonl'), ('claude', 'projects/*/*.jsonl')]
        for provider, pattern in patterns:
            for file in Path(home).glob(pattern):
                matches = UUID.findall(file.name)
                if not matches:
                    continue
                native = matches[-1]
                key = (provider, native)
                row = {'provider': provider, 'native_session_id': native,
                       'transcript': str(file.resolve()), 'transcript_mtime': file.stat().st_mtime,
                       'source': 'transcript-path', 'process_observed': False}
                # A file mtime proves activity on disk, never a live executor.
                if key not in rows or row['transcript_mtime'] > rows[key]['transcript_mtime']:
                    rows[key] = row
    return list(rows.values())


def reconcile(processes, panes, transcripts, core, legacy, routes, proposals, observations):
    """Join explicit identities only; cwd/name/mtime never establish ownership."""
    for p in processes:
        observation = next((o for o in observations if o.get('pid') == p['pid']
                            and o.get('provider') == p['provider']
                            and o.get('start_ticks') == p.get('start_ticks')), None)
        if observation and UUID.fullmatch(observation.get('native_session_id', '')):
            p['native_session_id'] = observation['native_session_id']
            p['identity_evidence'] = observation.get('source', 'operator-observation')
        p['panes'] = []
        ancestor = p['pid']
        # /proc records include only providers, so a separate parent map is supplied below.
        parents = p.pop('ancestors', [])
        candidates = {ancestor, p['ppid'], *parents}
        for pane in panes:
            if pane['pid'] in candidates:
                p['panes'].append(pane)
    grouped = {}
    for p in processes:
        key = (p['provider'], p['native_session_id'] or 'pid:' + str(p['pid']))
        row = grouped.setdefault(key, {'provider': p['provider'], 'native_session_id': p['native_session_id'],
                                      'processes': [], 'panes': [], 'process_observed': True})
        row['processes'].append({k: p[k] for k in ('pid', 'ppid', 'kind', 'source')})
        if p.get('identity_evidence'):
            row['identity_evidence'] = p['identity_evidence']
        for pane in p['panes']:
            if pane not in row['panes']:
                row['panes'].append(pane)
    # Include native Core sessions even if hosted by an infrastructure process.
    for b in core:
        if b.get('native_session_id'):
            key = (b['provider_kind'], b['native_session_id'])
            grouped.setdefault(key, {'provider': key[0], 'native_session_id': key[1], 'processes': [],
                                     'panes': [], 'process_observed': False})
    for row in grouped.values():
        native = row['native_session_id']
        row['core_bindings'] = [b for b in core if b['native_session_id'] == native and b['provider_kind'] == row['provider']]
        row['legacy_attachments'] = [{k: b.get(k) for k in ('threadId', 'lastSeenAt', 'source')}
                                     for b in legacy if native and b.get('apiSessionId') == native]
        row['proposed_linkage'] = [{k: p.get(k) for k in ('project', 'task', 'role', 'source')}
                                  for p in proposals if native and p.get('native_session_id') == native]
        row['ownership'] = 'core-bound' if row['core_bindings'] else 'unknown'
        row['transcript'] = next((t for t in transcripts if t['provider'] == row['provider'] and t['native_session_id'] == native), None)
        row['liveness'] = 'process-observed' if row['process_observed'] else 'not-established'
    return {'executors': list(grouped.values()), 'panes': panes,
            'posting_routes': [{ 'thread_id': tid, 'backend': r.get('backend'),
                                'conversation_id': r.get('conversation')} for tid, r in routes.items()],
            'notes': ['Posting routes, Core runtime bindings and legacy attachments are distinct evidence.',
                      'Proposed linkage is not an actual Core binding or a dispatch change.',
                      'Transcript modification time does not prove a live process.',
                      'Inherited identities from another provider and open transcript files do not establish native identity.',
                      'An absent legacy delegation is not proof that a V2 route is absent.']}


def parent_chain(pid, root='/proc'):
    chain, seen = [], set()
    while pid > 1 and pid not in seen and len(chain) < 64:
        seen.add(pid)
        try:
            status = (Path(root) / str(pid) / 'status').read_text().splitlines()
            pid = int(next(s.split()[1] for s in status if s.startswith('PPid:')))
            chain.append(pid)
        except (OSError, ValueError, StopIteration):
            break
    return chain


def markdown(report):
    lines = ['# Executor reconciliation', '', 'Private operational report. Proposed links do not change runtime bindings.', '',
             '| Provider / native identity | Process evidence | Terminal views | Ownership | Proposed role |',
             '| --- | --- | --- | --- | --- |']
    def safe(value):
        return str(value).replace('|', '\\|').replace('\n', ' ')
    for row in report['executors']:
        views = [v for pane in row['panes'] for v in pane['views']]
        roles = [p.get('role') for p in row['proposed_linkage']]
        lines.append('| ' + ' | '.join(safe(v) for v in [row['provider'] + ' / ' + (row['native_session_id'] or 'unknown'),
                      ', '.join(str(p['pid']) + (' (infrastructure)' if p['kind'] == 'infrastructure' else '')
                                for p in row['processes']) or 'not established',
                      ', '.join(views) or 'none observed', row['ownership'], ', '.join(roles) or 'none']) + ' |')
    lines += ['', 'Terminal views (shared pane IDs are one execution surface):', '', '| Socket / pane | Pane PID | Views |', '| --- | --- | --- |']
    for pane in report['panes']:
        lines.append('| ' + ' | '.join(safe(v) for v in [pane['socket'] + ' / ' + pane['pane'], pane['pid'], ', '.join(pane['views'])]) + ' |')
    lines += ['', 'Canonical bindings and proposed task links:', '']
    for row in report['executors']:
        for binding in row['core_bindings']:
            lines.append('- Core: ' + safe(row['native_session_id']) + ' → ' + safe(binding['conversation_id']) + ' (' + safe(binding['role']) + ')')
        for proposal in row['proposed_linkage']:
            lines.append('- Proposed only: ' + safe(row['native_session_id']) + ' → ' + safe(proposal.get('project')) + ' / ' + safe(proposal.get('task')) + ' (' + safe(proposal.get('role')) + ')')
    lines += ['', *report['notes'], '', 'Source provenance:']
    lines += ['- ' + safe(s['kind']) + ': ' + safe(s['path']) for s in report['sources']]
    lines += ['', 'Unavailable sources: ' + str(len(report.get('unavailable_sources', [])))]
    return '\n'.join(lines) + '\n'


def write_private(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Atomic 0600 replacement; no world-readable intermediate report.
    fd, temp = tempfile.mkstemp(prefix='.inventory-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(text)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('core', 'legacy', 'routes', 'proposals', 'observations'):
        parser.add_argument('--' + name)
    for name in ('home', 'socket', 'socket-root'):
        parser.add_argument('--' + name, action='append', default=[])
    parser.add_argument('--output', required=True, help='Private report basename; .json and .md are written')
    args = parser.parse_args()
    sources, errors = [{'kind': 'process-identities', 'path': '/proc'}], []
    def read(name, default):
        path = getattr(args, name)
        if not path:
            return default
        sources.append({'kind': name, 'path': str(Path(path).resolve())})
        try:
            return bindings(path) if name == 'core' else load(path)
        except (OSError, ValueError, sqlite3.Error):
            errors.append({'source': name, 'status': 'unavailable'})
            return default
    core = read('core', [])
    legacy = read('legacy', {}).get('bindings', [])
    if isinstance(legacy, dict):
        legacy = list(legacy.values())
    routes = read('routes', {}).get('threads', {})
    proposals = read('proposals', [])
    observations = read('observations', [])
    sockets = args.socket + [p for root in args.socket_root for p in glob.glob(str(Path(root) / '**/*'), recursive=True)
                             if Path(p).is_socket()]
    panes, tmux_errors = tmux_inventory(sockets)
    sources += [{'kind': 'tmux', 'path': p} for p in sorted(set(sockets))]
    sources += [{'kind': 'native-home', 'path': h} for h in unique_homes(args.home)]
    processes = proc_inventory()
    for process in processes:
        process['ancestors'] = parent_chain(process['pid'])
    report = reconcile(processes, panes, transcript_inventory(args.home), core, legacy, routes, proposals, observations)
    report.update({'schema_version': 1, 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'sources': sources, 'unavailable_sources': errors + tmux_errors})
    write_private(args.output + '.json', json.dumps(report, indent=2) + '\n')
    write_private(args.output + '.md', markdown(report))


if __name__ == '__main__':
    main()
