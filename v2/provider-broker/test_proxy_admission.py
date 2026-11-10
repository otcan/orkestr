"""Actual loopback sockets, synthetic relays; no account or external network."""
import socket
import unittest
from unittest.mock import patch
from isolation import supervisor


class AdmissionTests(unittest.TestCase):
    def test_capacity_refusal_is_bounded_and_slot_recovery_is_exact(self):
        admission=supervisor.RelayAdmission()
        clients=[]
        accepted=[]
        def synthetic_relay(peer,hosts):
            try:
                while peer.recv(128):pass
            finally:peer.close()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen(8);listener.settimeout(1)
            def connect():
                client=socket.create_connection(listener.getsockname(),timeout=1)
                clients.append(client)
                peer,_=listener.accept()
                return client,peer
            with patch.object(supervisor,'relay',synthetic_relay), patch.object(supervisor.os,'write') as diagnostic:
                try:
                    for _ in range(4):
                        client,peer=connect()
                        self.assertTrue(admission.admit(peer,('subscription.example.invalid',)))
                        accepted.append(client)
                    # Connections close before any CONNECT bytes, including
                    # caller-controlled headers, can reach a relay.
                    for _ in range(12):
                        client,peer=connect()
                        self.assertFalse(admission.admit(peer,()))
                        self.assertEqual(client.recv(1),b'')
                    diagnostic.assert_called_once_with(2,b'provider-egress: inner-capacity-refused\n')
                    self.assertEqual(len(admission.workers),4)
                    first=admission.workers[0]
                    accepted[0].shutdown(socket.SHUT_WR);first.join(1)
                    self.assertFalse(first.is_alive())
                    client,peer=connect()
                    self.assertTrue(admission.admit(peer,()))
                    self.assertEqual(len(admission.workers),4)
                finally:
                    for client in clients:client.close()
                    for worker in admission.workers:worker.join(1)
                    self.assertTrue(all(not worker.is_alive() for worker in admission.workers))

    def test_closed_diagnostic_sink_does_not_change_refusal(self):
        admission=supervisor.RelayAdmission()
        class Live:
            def is_alive(self):return True
        admission.workers=[Live() for _ in range(4)]
        client,peer=socket.socketpair()
        try:
            with patch.object(supervisor.os,'write',side_effect=OSError):
                self.assertFalse(admission.admit(peer,()))
            self.assertEqual(client.recv(1),b'')
            self.assertTrue(admission.reported)
        finally:client.close();peer.close()
