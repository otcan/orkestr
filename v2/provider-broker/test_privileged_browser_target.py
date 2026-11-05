"""Root-only kernel proof fixtures. No browser, credentials, HTTP or business calls."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import unittest
import uuid
import privileged_browser_target as proof


@unittest.skipUnless(os.geteuid()==0 and hasattr(os,'pidfd_open'),'explicit Linux Root fixture required')
class TargetProofTests(unittest.TestCase):
    def setUp(self):
        self.root=Path('/orkestr-browser-target-test-'+str(uuid.uuid4()))
        self.root.mkdir(mode=0o700)
        self.addCleanup(lambda:shutil.rmtree(self.root))
        self.listener=socket.socket();self.listener.bind(('127.0.0.1',0));self.listener.listen()
        self.addCleanup(self.listener.close)
        process=Path('/proc',str(os.getpid()))
        start,uid,network=proof.process_identity(process)
        inode=os.readlink(process/'fd'/str(self.listener.fileno()))[8:-1]
        self.target={'endpoint':'http://127.0.0.1:'+str(self.listener.getsockname()[1]),
                     'pid':os.getpid(),'start_ticks':start,'uid':uid,
                     'executable_sha256':hashlib.sha256((process/'exe').read_bytes()).hexdigest(),
                     'listener_inode':inode,'net_namespace':network}
        self.value={'schema_version':1,'desk_targets':{'synthetic-desk':self.target}}
        self.path=self.root/'target.json';self.write()

    def write(self):
        self.path.write_text(json.dumps(self.value));self.path.chmod(0o400)

    def test_original_live_process_owns_exact_loopback_listener(self):
        result=proof.verify(self.path,'synthetic-desk')
        self.assertEqual(result['pid'],os.getpid())
        self.assertEqual(result['endpoint'],self.target['endpoint'])
        self.assertEqual(result['listener_inode'],self.target['listener_inode'])

    def test_changed_start_uid_executable_namespace_inode_or_port_fail_closed(self):
        replacements={'start_ticks':self.target['start_ticks']+1,'uid':self.target['uid']+1,
                      'executable_sha256':'0'*64,'net_namespace':'net:[0]','listener_inode':'1',
                      'endpoint':'http://127.0.0.1:1'}
        original=dict(self.target)
        for key,value in replacements.items():
            with self.subTest(field=key):
                self.target.clear();self.target.update(original);self.target[key]=value;self.write()
                with self.assertRaises(proof.Refused):proof.verify(self.path,'synthetic-desk')

    def test_closed_listener_and_foreign_desk_are_not_retargeted(self):
        self.listener.close()
        with self.assertRaisesRegex(proof.Refused,'target_socket_not_owned'):
            proof.verify(self.path,'synthetic-desk')
        with self.assertRaisesRegex(proof.Refused,'target_not_configured'):
            proof.verify(self.path,'other-desk')

    def test_alias_or_writable_ancestor_descriptor_is_refused(self):
        alias=self.root/'alias.json';alias.symlink_to(self.path)
        with self.assertRaisesRegex(proof.Refused,'target_descriptor_alias'):
            proof.verify(alias,'synthetic-desk')
        self.root.chmod(0o777)
        with self.assertRaisesRegex(proof.Refused,'target_descriptor_custody'):
            proof.verify(self.path,'synthetic-desk')

    def test_endpoint_cannot_be_native_selected_remote_or_ambiguous(self):
        for endpoint in ['https://127.0.0.1:1234','http://localhost:1234','http://127.0.0.1:1234/',
                         'http://u@127.0.0.1:1234','http://192.0.2.1:1234','http://127.0.0.1:1234?q=x']:
            self.target['endpoint']=endpoint;self.write()
            with self.subTest(endpoint=endpoint):
                with self.assertRaisesRegex(proof.Refused,'target_endpoint'):
                    proof.verify(self.path,'synthetic-desk')

    def test_duplicate_fields_or_extra_authority_fields_are_refused(self):
        self.path.write_text('{"schema_version":1,"schema_version":1,"desk_targets":{}}')
        with self.assertRaisesRegex(proof.Refused,'target_descriptor_duplicate_key'):
            proof.verify(self.path,'synthetic-desk')
        self.target['native_target_override']='not allowed';self.write()
        with self.assertRaisesRegex(proof.Refused,'target_descriptor_shape'):
            proof.verify(self.path,'synthetic-desk')


if __name__=='__main__':unittest.main()
