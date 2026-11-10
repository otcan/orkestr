"""Synthetic namespace profile only: no canonical auth/native/network use."""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
from isolation.authenticated import SelectedCodexProfile, private_state
from isolation.authenticated_budget import AUTHENTICATED
from isolation.supervisor import destination
from isolation.egress import public_addresses


class AuthenticatedIsolationTests(unittest.TestCase):
    def test_unprovisioned_profile_refuses_before_spawn(self):
        with tempfile.TemporaryDirectory(prefix="untrusted-profile-synthetic-") as root:
            configuration=Path(root)/"profile.json"
            configuration.write_text("{}")
            with self.assertRaises(ValueError):SelectedCodexProfile(configuration)

    def test_connect_policy_refuses_external_plaintext_and_injection(self):
        hosts=("subscription.example.invalid",)
        for raw in (b"GET http://subscription.example.invalid/ HTTP/1.1\r\n\r\n",
                    b"CONNECT external.example.invalid:443 HTTP/1.1\r\n\r\n",
                    b"CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
                    b"CONNECT subscription.example.invalid:80 HTTP/1.1\r\n\r\n"):
            with self.subTest(raw=raw),self.assertRaises(ValueError):destination(raw,hosts)
        self.assertEqual(destination(b"CONNECT subscription.example.invalid:443 HTTP/1.1\r\nAuthorization: fake\r\n\r\n",hosts),
            b"CONNECT subscription.example.invalid:443 HTTP/1.1\r\nHost: subscription.example.invalid:443\r\n\r\n")

    def test_root_egress_dns_refuses_private_mixed_and_rebinding_targets(self):
        def records(*addresses):
            return [(socket.AF_INET,socket.SOCK_STREAM,6,"",(ip,443)) for ip in addresses]
        for answer in ([], records("127.0.0.1"),records("169.254.169.254"),
                       records("10.1.2.3"),records("1.1.1.1","127.0.0.1")):
            with self.subTest(answer=answer),self.assertRaises(ValueError):
                public_addresses("subscription.example.invalid",lambda *a,**k:answer)
        self.assertEqual(public_addresses("subscription.example.invalid",
            lambda *a,**k:records("1.1.1.1"))[0][3],("1.1.1.1",443))

    def test_role_state_refuses_auth_copy_config_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix="role-state-synthetic-") as tmp:
            root=Path(tmp)
            with patch("isolation.authenticated.private_path",return_value=str(root)):
                for name in ("config.toml","auth.json"):
                    item=root/name;item.write_text("synthetic-forbidden")
                    with self.assertRaises(ValueError):private_state(root)
                    item.unlink()
                (root/"sessions").symlink_to("/tmp")
                with self.assertRaises(ValueError):private_state(root)
                (root/"sessions").unlink()
                (root/"auth.json").touch(mode=0o600)
                (root/"state_5.sqlite").touch(mode=0o600)
                self.assertEqual(private_state(root),str(root))
        self.assertEqual(AUTHENTICATED.tunnel_seconds,900)
        self.assertEqual(AUTHENTICATED.tunnel_bytes,64*1024**2)

    def test_role_state_alias_and_top_level_types_refuse_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="state-alias-synthetic-") as tmp:
            base=Path(tmp);root=base/"state";root.mkdir(mode=0o700)
            target=base/"unmounted-target";target.write_bytes(b"synthetic-original")
            with patch("isolation.authenticated.private_path",return_value=str(root)):
                for nested in (False,True):
                    if nested:
                        (root/"sessions").mkdir(mode=0o700)
                    alias=root/"sessions"/"rollout" if nested else root/"state_5.sqlite"
                    os.link(target,alias)
                    with self.assertRaises(ValueError):private_state(root)
                    self.assertEqual(target.read_bytes(),b"synthetic-original")
                    alias.unlink()
                    if nested:(root/"sessions").rmdir()
                (root/"sessions").touch(mode=0o600)
                with self.assertRaises(ValueError):private_state(root)
                (root/"sessions").unlink()
                (root/"state_5.sqlite").mkdir(mode=0o700)
                with self.assertRaises(ValueError):private_state(root)
                self.assertEqual(target.read_bytes(),b"synthetic-original")

    def test_actual_private_namespace_proxy_and_selected_mounts(self):
        with tempfile.TemporaryDirectory(prefix="authenticated-profile-synthetic-") as tmp:
            root=Path(tmp);auth=root/"auth.json";auth.write_text('synthetic-selected-account')
            unrelated=root/"unrelated";unrelated.write_text("synthetic-unrelated-secret")
            sessions=root/"sessions";sessions.mkdir(mode=0o700);endpoint=root/"egress.sock"
            peer=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);peer.bind(str(endpoint));peer.listen();peer.settimeout(3)
            observed=[];errors=[]
            def serve():
                try:
                    connection,_=peer.accept()
                    with connection:
                        connection.settimeout(2);header=bytearray()
                        while not header.endswith(b"\r\n\r\n"):header.extend(connection.recv(1))
                        observed.append(bytes(header));connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                        observed.append(connection.recv(64));connection.sendall(b"synthetic-egress-reply")
                except Exception as error:errors.append(type(error).__name__)
            worker=threading.Thread(target=serve);worker.start()
            # Fixture-only construction bypasses root provisioning validation.
            # Production constructor requires immutable root config/endpoint.
            profile=object.__new__(SelectedCodexProfile)
            profile.native="/usr/bin/python3";profile.supervisor=str(Path(__file__).parent.resolve()/"isolation/supervisor.py")
            workspace=root/"workspace";workspace.mkdir(mode=0o700)
            profile.workspace=str(workspace)
            profile.auth=str(auth);profile.state_root=str(sessions);profile.sessions=None;profile.endpoint=str(endpoint)
            profile.hosts=("subscription.example.invalid",)
            source="\n".join([
                "import os,socket,urllib.parse,json,sys,resource,sqlite3",
                "assert resource.getrlimit(resource.RLIMIT_CPU)==(600,600)",
                "assert resource.getrlimit(resource.RLIMIT_AS)==(8*1024**3,8*1024**3)",
                "assert resource.getrlimit(resource.RLIMIT_NOFILE)==(256,256)",
                "assert sys.stdin.readline()=='synthetic-native-input\\n'",
                "assert open('/account/auth.json').read()=='synthetic-selected-account'",
                "assert not os.path.exists("+repr(str(unrelated))+")",
                "assert not os.path.exists("+repr(str(auth))+")",
                "try:\n open('/account/auth.json','w');raise AssertionError('auth writable')\nexcept OSError:pass",
                "try:\n socket.socket(socket.AF_UNIX);raise AssertionError('unix allowed')\nexcept OSError:pass",
                "a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM);a.sendall(b'x');assert b.recv(1)==b'x';a.close();b.close()",
                "try:\n socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM);raise AssertionError('datagram pair allowed')\nexcept OSError:pass",
                "try:\n socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET);raise AssertionError('seqpacket pair allowed')\nexcept OSError:pass",
                "try:\n os.fork();raise AssertionError('fork allowed')\nexcept OSError:pass",
                "try:\n socket.create_connection(('192.0.2.1',443),timeout=.1);raise AssertionError('host egress')\nexcept OSError:pass",
                "proxy=urllib.parse.urlparse(os.environ['HTTPS_PROXY'])",
                "s=socket.create_connection((proxy.hostname,proxy.port),timeout=2)",
                "s.sendall(b'CONNECT subscription.example.invalid:443 HTTP/1.1\\r\\nIgnored: value\\r\\n\\r\\n')",
                "header=b''\nwhile not header.endswith(b'\\r\\n\\r\\n'):header+=s.recv(1)",
                "assert header.startswith(b'HTTP/1.1 200')",
                "s.sendall(b'synthetic TLS bytes');assert s.recv(128)==b'synthetic-egress-reply';s.close()",
                "os.mkdir('/account/sessions')",
                "with open('/account/sessions/native-session','w') as f:f.write('synthetic-session')",
                "database=sqlite3.connect('/account/state_5.sqlite');database.execute('CREATE TABLE synthetic(value)');database.execute(\"INSERT INTO synthetic VALUES ('persistent')\");database.commit();database.close()",
                "with open('/account/session_index.jsonl','w') as f:f.write('synthetic-index')",
                "print(json.dumps({'uid':os.getuid(),'proxy':True,'selected':True}))",
            ])
            # One bounded line carries source to the synthetic supervisor only.
            payload="exec("+repr(source)+")"
            try:
                child=profile._start(payload)
                code,out,err=child.exchange(b"synthetic-native-input\n",timeout=5)
                self.assertEqual((code,err),(0,b""),out+err)
                self.assertTrue(json.loads(out)["proxy"])
                self.assertEqual(json.loads(out)["uid"],os.getuid())
                self.assertEqual((sessions/"sessions/native-session").read_text(),"synthetic-session")
                self.assertEqual(auth.read_text(),"synthetic-selected-account")
                import sqlite3
                database=sqlite3.connect(sessions/"state_5.sqlite")
                try:self.assertEqual(database.execute("SELECT value FROM synthetic").fetchone(),("persistent",))
                finally:database.close()
                self.assertEqual((sessions/"session_index.jsonl").read_text(),"synthetic-index")
                self.assertEqual((sessions/"auth.json").stat().st_size,0)
                worker.join(timeout=3);self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
                self.assertEqual(observed,[b"CONNECT subscription.example.invalid:443 HTTP/1.1\r\nHost: subscription.example.invalid:443\r\n\r\n",b"synthetic TLS bytes"])
            finally:
                peer.close();worker.join(timeout=4)
