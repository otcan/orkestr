"""Disposable native artifacts cannot poison durable role state on restart."""
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from isolation.authenticated import SelectedCodexProfile, private_state


class RestartTests(unittest.TestCase):
    def test_two_actual_namespace_launches_preserve_db_not_helpers(self):
        with tempfile.TemporaryDirectory(prefix="native-restart-synthetic-") as tmp:
            root=Path(tmp);state=root/"state";state.mkdir();auth=root/"auth.json"
            auth.write_text("synthetic-selected");work=root/"work";work.mkdir()
            endpoint=root/"endpoint"
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
                peer.bind(str(endpoint));peer.listen()
                profile=object.__new__(SelectedCodexProfile)
                profile.native="/usr/bin/python3"
                profile.supervisor=str(Path(__file__).parent.resolve()/"isolation/supervisor.py")
                profile.state_root=str(state);profile.sessions=None;profile.auth=str(auth)
                profile.workspace=str(work);profile.endpoint=str(endpoint)
                profile.hosts=("subscription.example.invalid",)
                source="\n".join([
                    "import os,sqlite3",
                    "assert os.listdir('/account/tmp')==[]",
                    "assert os.listdir('/account/skills')==[]",
                    "os.symlink('/opt/provider/native','/account/tmp/apply_patch')",
                    "open('/account/skills/synthetic','w').write('discard')",
                    "db=sqlite3.connect('/account/thread_history_1.sqlite')",
                    "db.execute('CREATE TABLE IF NOT EXISTS synthetic(value)')",
                    "db.execute('INSERT INTO synthetic VALUES (1)');db.commit()",
                    "print(db.execute('SELECT count(*) FROM synthetic').fetchone()[0])",
                    "db.close()",
                ])
                for expected in (1,2):
                    with patch('isolation.authenticated.private_path',return_value=str(state)):
                        self.assertEqual(private_state(state),str(state))
                    owned=profile._start("exec("+repr(source)+")")
                    try:
                        out,err=owned._child.communicate(timeout=4)
                        self.assertEqual((owned._child.returncode,out,err),(0,str(expected).encode()+b'\n',b''))
                    finally:owned.close()
                    for name in ('tmp','cache','skills','thread-writer-locks'):
                        self.assertEqual(list((state/name).iterdir()),[])
                self.assertEqual(auth.read_text(),'synthetic-selected')

    def test_legacy_nonempty_disposable_and_unknown_alias_refuse(self):
        with tempfile.TemporaryDirectory(prefix="legacy-state-synthetic-") as tmp:
            root=Path(tmp)
            with patch('isolation.authenticated.private_path',return_value=str(root)):
                for name in ('tmp','cache','skills','thread-writer-locks'):
                    folder=root/name;folder.mkdir()
                    alias=folder/'synthetic';alias.symlink_to('/opt/provider/native')
                    with self.assertRaises(ValueError):private_state(root)
                    self.assertTrue(alias.is_symlink())
                    alias.unlink();folder.rmdir()
                for name in ('goals_1','memories_1','queue_1','thread_history_1'):
                    for suffix in ('.sqlite','.sqlite-wal','.sqlite-shm','.sqlite-journal'):
                        (root/(name+suffix)).touch()
                for name in ('models_cache.json','installation_id','.sandbox_migration'):
                    (root/name).touch()
                self.assertEqual(private_state(root),str(root))
