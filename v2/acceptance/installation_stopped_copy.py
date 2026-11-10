import sys,tempfile,unittest,socket,os
from pathlib import Path
sys.path.insert(0,str(Path(os.environ['ORKESTR_V2_REVIEW_SOURCE_ROOT'])/'v2/local-install/tests'))
from stopped_copy import copy_home
class Independent(unittest.TestCase):
 def test_real_private_home_and_refusals(self):
  with tempfile.TemporaryDirectory() as raw:
   root=Path(raw);home=root/'home';home.mkdir(mode=0o700)
   for name in ('data','logs','control','releases','provider-home'):(home/name).mkdir(mode=0o700)
   for name in ('core.sqlite3','core.sqlite3-wal','core.sqlite3-shm'):(home/'data'/name).write_bytes(b'synthetic '+name.encode())
   target=root/'copy';copy_home(home,target)
   for path in (home/'data').iterdir():
    other=target/'data'/path.name
    self.assertEqual(path.read_bytes(),other.read_bytes());self.assertNotEqual(path.stat().st_ino,other.stat().st_ino)
   with self.assertRaises(RuntimeError):copy_home(home,home/'nested')
   self.assertFalse((home/'nested').exists())
   for kind in ('symlink','fifo','socket'):
    bad=home/'data'/'bad';peer=None
    if kind=='symlink':bad.symlink_to(root/'missing')
    elif kind=='fifo':os.mkfifo(bad)
    else:peer=socket.socket(socket.AF_UNIX);peer.bind(str(bad))
    refused=root/('refused-'+kind)
    try:
     with self.assertRaises(RuntimeError):copy_home(home,refused)
     self.assertFalse(refused.exists())
    finally:
     if peer:peer.close()
     bad.unlink()
if __name__=='__main__':unittest.main()
