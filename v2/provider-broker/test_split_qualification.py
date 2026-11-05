"""Disposable Root-only gate tests; synthetic ELF is not provider qualification."""
import json
import os
import subprocess
import time
from pathlib import Path
import unittest
from unittest.mock import patch

from codex_service.contract import Refused
from codex_service.manager import Manager
from codex_service.package import Package
from codex_service.qualification import (Gate, CODE_WORKFLOWS, BOUNDARY, INSTANCE,
    CONSUMERS, code_subject, instance_subject, encoded, start)
from codex_bounded.trust import exists
import test_codex_service_identity as identity_tests


@unittest.skipUnless(os.geteuid() == 0, 'Root-owned disposable package required')
class QualificationTests(identity_tests.SplitPackageTests):
    def provision(self, phase='core_held_bootstrap'):
        self.select_split()
        self.core_writer()
        self.folder = self.fixture.root / 'qualification'
        self.folder.mkdir(mode=0o700)
        for name in ('evidence', 'receipts', 'artifacts'):
            (self.folder / name).mkdir(mode=0o700)
        self.record = self.folder / 'record.json'
        self.marker = self.folder / 'maintenance.hold'
        self.marker.write_bytes(b'')
        self.marker.chmod(0o400)
        service = self.fixture.package / 'service.json'
        value = json.loads(service.read_text())
        value['qualification_record'] = str(self.record)
        service.write_bytes(encoded(value))
        beta = self.fixture.package / 'beta.json'
        value = json.loads(beta.read_text())
        value['deploy_maintenance_marker'] = str(self.marker)
        beta.write_bytes(encoded(value))
        manifest = self.fixture.package / 'manifest.json'
        value = json.loads(manifest.read_text())
        for name in ('service.json', 'beta.json'):
            value['files'][name] = self.digest(self.fixture.package / name)
        manifest.write_bytes(encoded(value))
        self.package = Package(self.fixture.package, self.digest(manifest))
        self.document = dict(format='orkestr-split-qualification-v1', phase=phase,
                             subject=instance_subject(self.package), evidence={})
        specs = [('code', code_subject(self.package), CODE_WORKFLOWS),
                 ('boundary', instance_subject(self.package), BOUNDARY)]
        if phase == 'qualified_runtime':
            specs += [('instance', instance_subject(self.package), INSTANCE),
                      ('consumers', instance_subject(self.package), CONSUMERS)]
        for kind, subject, keys in specs:
            receipts = {}
            for key in sorted(keys):
                artifact = self.artifact('artifacts', dict(kind=kind, workflow=key,
                    fixture='synthetic; no production/provider qualification'))
                receipts[key] = self.artifact('receipts', dict(
                    format='orkestr-root-qualified-proof-v1', kind=kind, slot=key,
                    subject=subject, artifact_sha256=artifact))
            envelope = dict(format='orkestr-split-evidence-v1', kind=kind,
                            subject=subject, receipts=receipts)
            self.document['evidence'][kind] = self.artifact('evidence', envelope)
        self.save()
        return self.package

    def core_writer(self):
        # Actual dropped authority child emits the same minimal status protocol;
        # no Root/test author writes the ACK, no business provider is involved.
        source = r'''#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <sys/stat.h>
int main(void) {
 char path[4096];struct timespec now;clock_gettime(CLOCK_REALTIME,&now);
 snprintf(path,sizeof(path),"%s/deploy-drain.status.json",getenv("ORKESTR_V2_HOME"));
 umask(077);FILE *f=fopen(path,"w");if(!f)return 2;
 fprintf(f,"{\"pid\":%d,\"draining\":true,\"maintenance_held\":true,\"updated_ms\":%lld}",
   getpid(),(long long)now.tv_sec*1000+now.tv_nsec/1000000);
 fclose(f);alarm(20);while(1)pause();
}'''
        target = self.fixture.package / 'server'
        target.chmod(0o750)
        subprocess.run(['cc', '-x', 'c', '-', '-o', str(target)], input=source.encode(),
                       capture_output=True, check=True, timeout=10)
        os.chown(target, 0, self.gid)
        target.chmod(0o550)
        manifest = self.fixture.package / 'manifest.json'
        value = json.loads(manifest.read_text())
        value['files']['server'] = self.digest(target)
        manifest.write_bytes(encoded(value))

    def artifact(self, category, value):
        import hashlib
        blob = encoded(value)
        sha = hashlib.sha256(blob).hexdigest()
        path = self.folder / category / (sha + '.json')
        path.write_bytes(blob)
        path.chmod(0o400)
        return sha

    def save(self):
        self.record.write_bytes(encoded(self.document))
        self.record.chmod(0o400)

    def test_actual_manager_starts_only_held_core_then_refuses_native(self):
        package = self.provision()
        manager = Manager(package.root, self.digest(package.root / 'manifest.json'))
        try:
            manager.start()
            self.assertEqual(manager.identity['uid'], package.authority_uid)
            self.assertIsNotNone(manager.child)
            with self.assertRaisesRegex(Refused, 'qualification_native_held'):
                manager.qualification.positive(manager.identity)
            self.assertEqual(manager.windows, {})
            self.assertIsNone(manager.launcher)
        finally:
            manager.close()

    def test_missing_changed_unprotected_alias_and_hardlink_records_fail_closed(self):
        package = self.provision()
        original = self.record.read_bytes()
        for mode in (0o600, 0o440, 0o444):
            self.record.chmod(mode)
            with self.assertRaisesRegex(Refused, 'split_launch_unqualified'):start(package)
        self.record.chmod(0o400)
        alias = self.folder / 'alias'
        os.link(self.record, alias)
        with self.assertRaisesRegex(Refused, 'split_launch_unqualified'):start(package)
        alias.unlink()
        self.record.rename(alias)
        self.record.symlink_to(alias)
        with self.assertRaisesRegex(Refused, 'split_launch_unqualified'):start(package)
        self.record.unlink();alias.rename(self.record)
        self.record.unlink()
        with self.assertRaisesRegex(Refused, 'split_launch_unqualified'):start(package)
        self.record.write_bytes(original);self.record.chmod(0o400)
        self.assertIsNotNone(start(package))

    def test_manifest_identity_phase_closed_shape_and_receipt_binding(self):
        package = self.provision('qualified_runtime')
        original = json.loads(encoded(self.document))
        for key in ('manifest_sha256', 'source_commit', 'authority_uid', 'executor_gid'):
            self.document = json.loads(encoded(original))
            self.document['subject'][key] = 'wrong'
            self.save()
            with self.assertRaises(Refused):start(package)
        for mutation in ('extra', 'boolean', 'missing_consumer', 'stale_receipt'):
            self.document = json.loads(encoded(original))
            if mutation == 'extra':self.document['passed'] = True
            if mutation == 'boolean':self.document['evidence']['code'] = True
            if mutation == 'missing_consumer':del self.document['evidence']['consumers']
            if mutation == 'stale_receipt':self.document['evidence']['code'] = '0' * 64
            self.save()
            with self.assertRaises(Refused):start(package)

    def test_synthetic_manifest_is_not_confused_with_code_subject(self):
        package = self.provision()
        subject = code_subject(package)
        self.assertNotIn('manifest_sha256', subject)
        self.assertIn('codex_service/qualification.py', subject['root_modules'])
        gate = Gate(package)
        envelope = self.folder / 'evidence' / (self.document['evidence']['code'] + '.json')
        value = json.loads(envelope.read_bytes())
        value['subject']['root_modules']['codex_service/manager.py'] = '0' * 64
        self.document['evidence']['code'] = self.artifact('evidence', value)
        self.save()
        with self.assertRaises(Refused):Gate(package)
        self.assertEqual(gate.phase, 'core_held_bootstrap')

    def test_lifetime_bootstrap_ceiling_marker_and_record_revocation(self):
        package = self.provision()
        gate = Gate(package)
        self.marker.unlink()
        with self.assertRaisesRegex(Refused, 'qualification_hold_lost'):gate.observe(None)
        self.marker.write_bytes(b'');self.marker.chmod(0o400)
        self.document['phase'] = 'qualified_runtime'
        self.save()
        with self.assertRaisesRegex(Refused, 'qualification_record_replaced'):gate.observe(None)
        self.assertEqual(gate.phase, 'core_held_bootstrap')

    def test_runtime_actual_child_ack_then_root_clear_and_rehold(self):
        package = self.provision('qualified_runtime')
        manager = Manager(package.root, self.digest(package.root / 'manifest.json'))
        try:
            manager.start()
            deadline = time.monotonic() + 5
            while not manager.qualification.acknowledged and time.monotonic() < deadline:
                manager.qualification.observe(manager.identity)
                time.sleep(.01)
            self.assertTrue(manager.qualification.acknowledged)
            with self.assertRaisesRegex(Refused, 'qualification_native_held'):
                manager.qualification.positive(manager.identity)
            self.marker.unlink()
            manager.qualification.positive(manager.identity)
            # A replacement Root hold must immediately revoke positives. It is
            # not the original inode, hence this manager cannot resume again.
            self.marker.write_bytes(b'');self.marker.chmod(0o400)
            with self.assertRaises(Refused):manager.qualification.positive(manager.identity)
        finally:
            manager.close()

    def test_atomic_root_publisher_refuses_unqualified_replacement(self):
        from codex_service.qualification_publish import publish
        package = self.provision()
        old = self.record.read_bytes()
        result = publish(package, 'core_held_bootstrap', self.document['evidence'])
        self.assertEqual(result, self.digest(self.record))
        self.assertEqual(self.record.stat().st_mode & 0o777, 0o400)
        for evidence in ({}, {**self.document['evidence'], 'instance': True}):
            with self.assertRaises(Refused):publish(package, 'qualified_runtime', evidence)
            self.assertEqual(self.record.read_bytes(), old)
        self.assertEqual(list(self.folder.glob('.qualification-*')), [])
        self.marker.unlink()
        with self.assertRaises(Refused):publish(package, 'core_held_bootstrap', self.document['evidence'])
        self.assertEqual(self.record.read_bytes(), old)

    def test_executor_cannot_read_or_replace_root_qualification(self):
        package = self.provision()
        script = 'import os,sys; p=sys.argv[1]; failed=0\nfor mode in (os.O_RDONLY,os.O_WRONLY):\n try: f=os.open(p,mode);os.close(f);failed+=1\n except PermissionError: pass\nraise SystemExit(failed)'
        result = subprocess.run(['/usr/bin/python3', '-I', '-S', '-B', '-c', script,
                                 str(self.record)], user=package.executor_uid,
            group=package.executor_gid, extra_groups=[], capture_output=True,
            env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_qualified_routine_restart_owns_only_its_new_nonce_hold(self):
        package = self.provision('qualified_runtime')
        self.marker.unlink()
        previous = None
        for _ in range(2):
            manager = Manager(package.root, self.digest(package.root / 'manifest.json'))
            try:
                manager.start()
                self.assertTrue(self.marker.exists())
                self.assertIsNotNone(manager.qualification.boot_nonce)
                deadline = time.monotonic() + 5
                while not manager.qualification.acknowledged and time.monotonic() < deadline:
                    manager.qualification.observe(manager.identity)
                    time.sleep(.01)
                self.assertTrue(manager.qualification.acknowledged)
                self.assertFalse(self.marker.exists())
                manager.qualification.positive(manager.identity)
                self.assertNotEqual(previous, manager.identity['pid'])
                previous = manager.identity['pid']
            finally:
                manager.close()
                self.assertIsNotNone(manager.child.returncode)

    def test_shutdown_control_failure_still_reaps_exact_original_core_and_reports_failure(self):
        package = self.provision()
        manager = Manager(package.root, self.digest(package.root / 'manifest.json'))
        try:
            manager.start()
            original = dict(manager.identity)
            # Keep the actual child alive until the negative-control callback
            # fails, so this covers the exception path rather than a quick exit.
            with patch.object(manager.child, 'send_signal', return_value=None), \
                 patch.object(manager, 'once', side_effect=Refused('synthetic_shutdown_control_failure')):
                self.assertFalse(manager.close())
            self.assertIsNotNone(manager.child.returncode)
            self.assertFalse(exists(original))
            self.assertTrue(manager.failed)
        finally:
            if manager.child and manager.child.poll() is None:
                manager.child.kill(); manager.child.wait(3)

    def test_boot_nonce_never_clears_replaced_or_inplace_operator_hold(self):
        package = self.provision('qualified_runtime')
        for replace in (False, True):
            self.marker.unlink()
            gate = Gate(package)
            with self.assertRaisesRegex(Refused, 'qualification_boot_ack_required'):
                gate.release_boot_hold()
            self.assertTrue(self.marker.exists())
            if replace:
                # Retain the prior inode so filesystem allocation cannot reuse it.
                old = self.marker.with_suffix('.previous')
                self.marker.rename(old)
                self.marker.write_bytes(b'operator hold')
                self.marker.chmod(0o400)
            else:
                self.marker.write_bytes(b'operator hold')
            # Unit-level CAS seam only; actual child ACK is exercised above.
            gate.acknowledged = True
            with self.assertRaises(Refused):gate.release_boot_hold()
            self.assertEqual(self.marker.read_bytes(), b'operator hold')
            if replace:old.unlink()
        self.marker.unlink()
        # A publication validation does not create a boot hold as a side effect.
        from codex_service.qualification_publish import publish
        with self.assertRaises(Refused):publish(package, 'qualified_runtime', self.document['evidence'])
        self.assertFalse(self.marker.exists())

    def test_bootstrap_without_operator_hold_remains_unqualified(self):
        package = self.provision()
        self.marker.unlink()
        with self.assertRaisesRegex(Refused, 'split_launch_unqualified'):start(package)
        self.assertFalse(self.marker.exists())

    def test_authority_uid_and_matching_pid_alone_cannot_forge_selected_core_ack(self):
        from codex_bounded.trust import process
        package = self.provision('qualified_runtime')
        gate = Gate(package)
        script = ('import json,os,sys,time;from pathlib import Path;os.umask(0o077);'
                  'Path(sys.argv[1]).write_text(json.dumps(dict(pid=os.getpid(),draining=True,'
                  'maintenance_held=True,updated_ms=time.time_ns()//1000000)));time.sleep(10)')
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-S', '-B', '-c', script,
                                 str(package.data / 'deploy-drain.status.json')],
            user=package.authority_uid, group=package.authority_gid, extra_groups=[],
            env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not (package.data / 'deploy-drain.status.json').exists() and time.monotonic() < deadline:
                time.sleep(.01)
            with self.assertRaisesRegex(Refused, 'qualification_core_executable'):
                gate.observe(process(child.pid))
            self.assertFalse(gate.acknowledged)
        finally:
            child.terminate();child.wait(timeout=5)

    def test_runtime_requires_actual_fresh_core_ack_before_hold_can_clear(self):
        package = self.provision('qualified_runtime')
        gate = Gate(package)
        self.assertTrue(gate.observe(None))
        self.marker.unlink()
        with self.assertRaisesRegex(Refused, 'qualification_hold_lost'):gate.observe(None)


if __name__ == '__main__':unittest.main()
