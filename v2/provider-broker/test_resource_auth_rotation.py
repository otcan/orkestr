"""Synthetic metadata-only account refresh; other resource pins remain strict."""
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from codex_service.contract import Refused
from codex_service.resource_namespace import Activation
from codex_service.resource_receipt import check_source,checked_source,target_inode,CODEX_AUTH_MAX_BYTES
import test_resource_namespace as fixtures

OLD=fixtures.OLD


@unittest.skipUnless(os.geteuid()==0,'Root source metadata fixture')
class ResourceAuthRotationTests(unittest.TestCase):
    setUp=fixtures.ResourceNamespaceTests.setUp
    directory=fixtures.ResourceNamespaceTests.directory
    file=fixtures.ResourceNamespaceTests.file
    save=fixtures.ResourceNamespaceTests.save

    def rotate(self,content=b'synthetic-rotated-auth'):
        replacement=self.file('old-home/.codex/auth.replacement',OLD,content)
        os.replace(replacement,self.auth)

    def test_atomic_auth_refresh_reuses_scope_without_reading_credential_bytes(self):
        row=self.doc['resources'][0];previous=row['inode'];self.rotate()
        self.assertNotEqual(self.auth.stat().st_ino,previous)
        with patch('os.read',side_effect=AssertionError('credential bytes must not be read')):
            info=check_source(row,homes=self.doc['source_homes'])
            fd=checked_source(row,homes=self.doc['source_homes'])
            try:self.assertEqual(os.fstat(fd).st_ino,info.st_ino)
            finally:os.close(fd)
        self.assertEqual(row['inode'],previous,'the sealed contract is never rewritten')

    def test_non_auth_file_replacement_remains_strict(self):
        replacement=self.file('old-home/.codex/lock.replacement',OLD,b'')
        os.replace(replacement,self.lock)
        with self.assertRaisesRegex(Refused,'resource_source_changed'):
            check_source(self.doc['resources'][1],homes=self.doc['source_homes'])

    def test_rotated_auth_cannot_change_custody_type_links_or_size(self):
        for invalid in ('mode','owner','group','hardlink','symlink','empty','oversized','device'):
            with self.subTest(invalid=invalid):
                self.rotate()
                row=dict(self.doc['resources'][0])
                if invalid=='mode':self.auth.chmod(0o644)
                elif invalid=='owner':os.chown(self.auth,OLD+1,OLD)
                elif invalid=='group':os.chown(self.auth,OLD,OLD+1)
                elif invalid=='hardlink':os.link(self.auth,self.auth.with_suffix('.alias'))
                elif invalid=='symlink':
                    original=self.auth.with_suffix('.original');self.auth.rename(original);self.auth.symlink_to(original)
                elif invalid=='empty':self.auth.write_bytes(b'')
                elif invalid=='oversized':self.auth.write_bytes(b'x'*(CODEX_AUTH_MAX_BYTES+1))
                elif invalid=='device':row['device']+=1
                with self.assertRaises((Refused,OSError)):
                    check_source(row,homes=self.doc['source_homes'])

    def test_receipt_inode_is_closed_metadata_and_not_a_pin_override_for_other_resources(self):
        row=self.doc['resources'][0]
        target=dict(target=row['target'],mount_id=1,source_inode=row['inode']+1)
        self.assertEqual(target_inode(row,target),row['inode']+1)
        for invalid in (None,True,0,-1,2**63):
            with self.subTest(invalid=invalid),self.assertRaises(Refused):
                target_inode(row,dict(target,source_inode=invalid))
        with self.assertRaises(Refused):target_inode(row,dict(target,unexpected=True))
        lock=self.doc['resources'][1]
        with self.assertRaises(Refused):target_inode(lock,dict(target, target=lock['target']))

    def test_actual_namespace_attests_the_fresh_opened_inode(self):
        before=self.doc['resources'][0]['inode'];self.rotate();fresh=self.auth.stat().st_ino
        with Activation(self.selected,self.ctx):
            from codex_service.resource_receipt import verify
            value=verify(self.selected,self.ctx)
            observed=next(row for row in value['targets'] if row['target']==self.profile['auth_file'])
            self.assertEqual(observed['source_inode'],fresh)
            self.assertNotEqual(observed['source_inode'],before)
            self.assertEqual(Path(self.profile['auth_file']).stat().st_ino,fresh)


if __name__=='__main__':unittest.main()
