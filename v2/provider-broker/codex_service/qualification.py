"""Root-authored split cutover evidence and immutable manager phase ceiling.

External records are never package inventory bytes. They authorize no business
operation themselves: normal Core, window, custody and command fences still run.
Only Root can author evidence; API/caller claims are not evidence inputs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

from codex_bounded.trust import digest, process, protected
from .contract import Refused, require

FORMAT = 'orkestr-split-qualification-v1'
CODE_WORKFLOWS = frozenset(('native_fresh_resume', 'native_tools_stop', 'workspace_commands',
    'attachment_export', 'provider_routing', 'source_continuation', 'fast_sampler'))
BOUNDARY = frozenset(('core_private', 'executor_no_authority', 'ipc_denied', 'maintenance_hold'))
INSTANCE = frozenset(('provider_accounts', 'business_resources', 'profile_parity', 'ipc_preflight'))
CONSUMERS = frozenset(('root-posts', 'v2-canary', 'claude-canary', 'timer-handoff',
    'new-chat', 'root-source', 'agent-timer-grants', 'wa-adapter'))
NEGATIVE = frozenset(('status', 'drain', 'uncertain', 'retire', 'reconcile', 'desk_login_poll', 'desk_login_cancel',
    'managed_poll', 'managed_cancel', 'managed_run_close', 'workspace_command_receipt',
    'workspace_command_cancel', 'workspace_attest'))


def sha(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def unchanged(before, after):
    return all(getattr(before, key) == getattr(after, key) for key in
               ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns"))


def read(path, limit=4 * 1024 * 1024):
    path = protected(path)
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_IMODE(before.st_mode) == 0o400 and before.st_size <= limit,
                'qualification_custody')
        blob = os.read(fd, limit + 1)
        after = os.fstat(fd)
        require(unchanged(before, after) and len(blob) == before.st_size, 'qualification_changed')
        value = json.loads(blob, object_pairs_hook=unique,
                           parse_constant=lambda _: require(False, 'qualification_nonfinite'))
        require(type(value) is dict, 'qualification_object')
        return value, hashlib.sha256(blob).hexdigest()
    finally:
        os.close(fd)


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'qualification_duplicate_key')
        value[key] = item
    return value


def code_subject(package):
    # Generated launchers contain installation paths. Source modules do not;
    # this map intentionally permits synthetic workflow manifests to differ.
    return {'source_commit': package.manifest['source_commit'],
        'server_sha256': package.manifest['files']['server'],
        'root_modules': {key: value for key, value in package.manifest['files'].items()
                         if '/' in key and key.endswith('.py')}}


def instance_subject(package):
    # Includes every sealed private path/configuration via the manifest digest,
    # without publishing those paths or credential content in evidence output.
    return {'manifest_sha256': digest(package.root / 'manifest.json'),
        'source_commit': package.manifest['source_commit'],
        'authority_uid': package.authority_uid, 'authority_gid': package.authority_gid,
        'executor_uid': package.executor_uid, 'executor_gid': package.executor_gid}


def check_path(value, home=None, root=None):
    require(type(value) is str and value.startswith('/') and value != '/'
            and len(value) <= 4096 and not any(ord(c) < 32 for c in value)
            and all(p not in ('', '.', '..') for p in value.split('/')[1:]),
            'qualification_record_path')
    path = Path(value)
    for excluded in (home, root):
        require(excluded is None or Path(excluded) not in (path, *path.parents),
                'qualification_record_overlap')
    return path


class Gate:
    def __init__(self, package, allow_boot_hold=True):
        self.package = package
        self.path = check_path(package.runtime.get('qualification_record'), package.home, package.root)
        self.started_ms = time.time_ns() // 1_000_000
        self.acknowledged = False
        self.ack_deadline = time.monotonic() + 30
        self.record, self.record_hash = self.load()
        self.phase = self.record['phase']  # Ceiling never follows a later record.
        self.marker = check_path(package.beta.get('deploy_maintenance_marker'), package.home)
        self.boot_nonce = None
        self.marker_identity = self.hold_identity()
        if self.marker_identity is None and self.phase == 'qualified_runtime' and allow_boot_hold:
            self.create_boot_hold()
            self.marker_identity = self.hold_identity()
        require(self.marker_identity is not None, 'qualification_initial_hold_required')

    def evidence(self, name, wanted_subject, keys):
        value = self.record['evidence'][name]
        require(sha(value), 'qualification_evidence_digest')
        path = self.path.parent / 'evidence' / (value + '.json')
        envelope, actual = read(path)
        require(actual == value and set(envelope) == {'format', 'kind', 'subject', 'receipts'}
                and envelope['format'] == 'orkestr-split-evidence-v1'
                and envelope['kind'] == name and encoded(envelope['subject']) == encoded(wanted_subject)
                and type(envelope['receipts']) is dict and set(envelope['receipts']) == keys,
                'qualification_evidence_binding')
        # Each Root-reviewed receipt is itself retained immutably. No boolean
        # result or caller-provided model narrative can stand in for an artifact.
        require(len(set(envelope['receipts'].values())) == len(keys),
                'qualification_receipt_reused')
        for slot, receipt in envelope['receipts'].items():
            require(sha(receipt), 'qualification_receipt_digest')
            proof, actual = read(self.path.parent / 'receipts' / (receipt + '.json'))
            require(actual == receipt and set(proof) ==
                    {'format', 'kind', 'slot', 'subject', 'artifact_sha256'}
                    and proof['format'] == 'orkestr-root-qualified-proof-v1'
                    and proof['kind'] == name and proof['slot'] == slot
                    and encoded(proof['subject']) == encoded(wanted_subject) and sha(proof['artifact_sha256']),
                    'qualification_receipt_binding')
            _, artifact = read(self.path.parent / 'artifacts' / (proof['artifact_sha256'] + '.json'))
            require(artifact == proof['artifact_sha256'], 'qualification_artifact_binding')

    def load(self):
        record, actual = read(self.path, 65536)
        require(set(record) == {'format', 'phase', 'subject', 'evidence'}
                and record['format'] == FORMAT
                and record['phase'] in ('core_held_bootstrap', 'qualified_runtime')
                and encoded(record['subject']) == encoded(instance_subject(self.package))
                and type(record['evidence']) is dict, 'qualification_record_binding')
        self.record = record
        required = {'code', 'boundary'}
        if record['phase'] == 'qualified_runtime':
            required |= {'instance', 'consumers'}
        require(set(record['evidence']) == required, 'qualification_evidence_set')
        self.evidence('code', code_subject(self.package), CODE_WORKFLOWS)
        self.evidence('boundary', record['subject'], BOUNDARY)
        if 'instance' in required:
            self.evidence('instance', record['subject'], INSTANCE)
            self.evidence('consumers', record['subject'], CONSUMERS)
        return record, actual

    def hold_identity(self):
        protected(self.marker.parent, True)
        try:
            info = self.marker.lstat()
        except FileNotFoundError:
            return None
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) in (0o400, 0o600), 'qualification_hold_custody')
        return (info.st_dev, info.st_ino)

    def create_boot_hold(self):
        # Only an already-qualified routine restart can create this temporary
        # hold. Never adopt or remove a preexisting operator/previous boot hold.
        nonce = ('orkestr-qualified-boot:' + str(uuid.uuid4()) + '\n').encode()
        folder = os.open(self.marker.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            try:
                fd = os.open(self.marker.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                             | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400, dir_fd=folder)
            except FileExistsError:
                return
            try:
                require(os.write(fd, nonce) == len(nonce), 'qualification_boot_hold_write')
                os.fsync(fd)
                self.boot_stat = os.fstat(fd)
                info = os.fstat(folder)
                self.boot_parent = (info.st_dev, info.st_ino)
                self.boot_nonce = nonce
            finally:
                os.close(fd)
            os.fsync(folder)
        finally:
            os.close(folder)

    def release_boot_hold(self):
        if self.boot_nonce is None:
            return False
        require(self.acknowledged and self.phase == 'qualified_runtime', 'qualification_boot_ack_required')
        folder = os.open(protected(self.marker.parent, True),
                         os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(folder)
            require((info.st_dev, info.st_ino) == self.boot_parent, 'qualification_boot_parent')
            fd = os.open(self.marker.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
            try:
                info = os.fstat(fd)
                require(unchanged(self.boot_stat, info) and info.st_nlink == 1
                        and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o400
                        and os.read(fd, 256) == self.boot_nonce, 'qualification_boot_hold_changed')
                current = os.stat(self.marker.name, dir_fd=folder, follow_symlinks=False)
                require(unchanged(info, current), 'qualification_boot_hold_changed')
                os.unlink(self.marker.name, dir_fd=folder)
                os.fsync(folder)
                self.boot_nonce = None
                return True
            finally:
                os.close(fd)
        finally:
            os.close(folder)

    def observe(self, identity):
        from .resource_receipt import verify_package
        verify_package(self.package)
        _, current = read(self.path, 65536)
        require(current == self.record_hash, 'qualification_record_replaced')
        held = self.hold_identity()
        if held is not None:
            require(held == self.marker_identity, 'qualification_hold_replaced')
        else:
            require(self.phase == 'qualified_runtime' and self.acknowledged,
                    'qualification_hold_lost')
        if identity is not None:
            live = process(identity['pid'])
            require(live == identity and identity['uid'] == self.package.authority_uid
                    and identity['ppid'] == os.getpid(), 'qualification_core_identity')
        if self.acknowledged:
            self.executable(identity)
            return held is not None
        if identity is None:
            return held is not None
        require(time.monotonic() <= self.ack_deadline, 'qualification_hold_ack_timeout')
        # ACK is actual authority-owned Core output, bound to the original
        # manager child, fresh startup, held marker and unchanged executable.
        path = self.package.data / 'deploy-drain.status.json'
        try:
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        except FileNotFoundError:
            return True
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == self.package.authority_uid
                    and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
                    and info.st_size <= 65536, 'qualification_ack_custody')
            status = json.loads(os.read(fd, 65537), object_pairs_hook=unique)
            require(unchanged(info, os.fstat(fd)), 'qualification_ack_changed')
        finally:
            os.close(fd)
        require(type(status) is dict, 'qualification_ack_shape')
        # A prior manager's durable ACK may remain until this Core binds its
        # drain state. It is never proof for the new child; wait under hold.
        if status.get('pid') != identity['pid'] or (type(status.get('updated_ms')) is int
                and status['updated_ms'] < self.started_ms):
            return True
        require(status.get('maintenance_held') is True and status.get('draining') is True
                and type(status.get('updated_ms')) is int
                and self.started_ms <= status['updated_ms'] <= time.time_ns() // 1_000_000 + 1000
                and digest(self.package.root / 'server') == self.package.manifest['files']['server'],
                'qualification_hold_ack')
        self.executable(identity)
        self.acknowledged = True
        return not self.release_boot_hold()

    def executable(self, identity):
        require(identity is not None, 'qualification_core_required')
        executable = Path('/proc') / str(identity['pid']) / 'exe'
        current, selected = executable.stat(), (self.package.root / 'server').stat()
        require((current.st_dev, current.st_ino) == (selected.st_dev, selected.st_ino),
                'qualification_core_executable')

    def positive(self, identity):
        require(identity is not None, 'qualification_core_required')
        held = self.observe(identity)
        require(self.phase == 'qualified_runtime' and self.acknowledged and not held,
                'qualification_native_held')


def start(package):
    if not getattr(package, 'identity_split', False):
        return None
    try:
        return Gate(package)
    except Exception:
        raise Refused('split_launch_unqualified') from None


def guard(manager, operation=None):
    gate = getattr(manager, 'qualification', None)
    if gate is not None and operation not in NEGATIVE:
        gate.positive(manager.identity)
