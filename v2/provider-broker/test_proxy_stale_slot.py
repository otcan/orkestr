"""Force a relay to finish while the actual supervisor waits in accept."""
import os
import queue
import socket
import sys
import threading
import unittest
from unittest.mock import patch
from isolation import supervisor


class StaleSlotTests(unittest.TestCase):
    def test_exit_during_accept_reclaims_slot_without_raising_limit(self):
        done=threading.Event();ready=threading.Event();at_accept=threading.Event()
        release_accept=threading.Event();started=queue.Queue();relays=[];clients=[]
        diagnostic_written=threading.Event()
        address=[];errors=[];original_accept=socket.socket.accept
        fd=os.open('/dev/null',os.O_RDONLY)
        class Child:
            def poll(self):return 0 if done.is_set() else None
            def wait(self,timeout=None):done.wait(timeout);return 0
            def kill(self):done.set()
        def popen(command,**kwargs):
            address.append(('127.0.0.1',int(kwargs['env']['HTTPS_PROXY'].rsplit(':',1)[1])))
            ready.set();return Child()
        def relay(client,hosts):
            release=threading.Event();entry=(threading.current_thread(),release)
            relays.append(entry);started.put(entry)
            try:release.wait(5)
            finally:client.close()
        def accept(listener):
            if listener.family==socket.AF_INET and len(relays)==4 and not at_accept.is_set():
                at_accept.set()
                if not release_accept.wait(2):raise TimeoutError('synthetic barrier expired')
            return original_accept(listener)
        def run():
            try:self.assertEqual(supervisor.main(),0)
            except BaseException as error:errors.append(error)
        def connect():
            client=socket.create_connection(address[0],timeout=2)
            clients.append(client);return client
        controller=threading.Thread(target=run)
        try:
            with patch.object(supervisor.subprocess,'Popen',popen), \
                 patch.object(supervisor,'relay',relay), \
                 patch.object(socket.socket,'accept',accept), \
                 patch.object(supervisor.os,'write',side_effect=lambda *_:diagnostic_written.set()) as diagnostic, \
                 patch.object(sys,'argv',['supervisor.py',str(fd),'subscription.example.invalid','codex']):
                controller.start();self.assertTrue(ready.wait(2))
                for _ in range(4):connect();started.get(timeout=2)
                self.assertTrue(at_accept.wait(2))
                thread,release=relays[0];release.set();thread.join(1)
                self.assertFalse(thread.is_alive())
                self.assertEqual(sum(t.is_alive() for t,_ in relays),3)
                connect();release_accept.set()
                # Old pre-accept accounting refuses this client instead.
                started.get(timeout=2)
                self.assertEqual(sum(t.is_alive() for t,_ in relays),4)
                diagnostic.assert_not_called()
                refused=connect()
                self.assertEqual(refused.recv(1),b'')
                self.assertTrue(diagnostic_written.wait(2))
                diagnostic.assert_called_once_with(2,b'provider-egress: inner-capacity-refused\n')
                thread,release=relays[1];release.set();thread.join(1)
                connect();started.get(timeout=2)
                self.assertEqual(sum(t.is_alive() for t,_ in relays),4)
                done.set();controller.join(2)
                self.assertFalse(controller.is_alive())
            self.assertEqual(errors,[])
        finally:
            done.set();release_accept.set()
            for client in clients:client.close()
            for thread,release in relays:release.set();thread.join(2)
            if controller.ident:controller.join(2)
            self.assertTrue(all(not t.is_alive() for t,_ in relays))
            self.assertFalse(controller.is_alive())
            try:os.close(fd)
            except OSError:pass
