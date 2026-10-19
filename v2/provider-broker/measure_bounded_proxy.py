"""Native-free resource observation of the real inner/root relay modules."""
import json
import os
from pathlib import Path
import threading

from bounded_proxy_fixture import Fixture
from isolation.bounded_io import ESTABLISHED


def descriptors():
    return len(os.listdir('/proc/self/fd'))


def rss_kib():
    return int(next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines()
                    if line.startswith('VmRSS:')))


def main():
    before_fds=descriptors();before_threads=threading.active_count();before_rss=rss_kib()
    with Fixture() as fixture:
        clients=[fixture.client() for _ in range(8)]
        for client in clients:assert fixture.response(client)==ESTABLISHED
        for _ in range(4):fixture.client()
        fixture.until(lambda:len(fixture.pool.pending)==4)
        for client in clients:
            client.sendall(b'x'*1024)
            received=bytearray()
            while len(received)<1024:received.extend(client.recv(1024-len(received)))
            assert received==b'x'*1024
        fixture.until(lambda:fixture.budget.bytes==16384)
        inner=[c for c,_ in fixture.inner.pool.active]+list(fixture.inner.pool.pending)
        outer=[c for c,_ in fixture.pool.active]+list(fixture.pool.pending)
        result={'active_per_layer':8,'pending_per_layer':4,
            'inner_owned_relay_descriptors':sum(s.fileno()>=0 for c in inner for s in c.sockets),
            'outer_owned_relay_descriptors':sum(s.fileno()>=0 for c in outer for s in c.sockets),
            'relay_threads':len(fixture.inner.pool.active)+len(fixture.pool.active),
            'all_process_fd_delta_including_test_peers':descriptors()-before_fds,
            'all_process_thread_delta_including_test_loops':threading.active_count()-before_threads,
            'rss_kib_before':before_rss,'rss_kib_with_test_peers':rss_kib(),
            'expected_combined_direction_payload_bytes':16384,'root_charged_bytes':fixture.budget.bytes,
            'inner_independent_charged_bytes':fixture.inner.budget.bytes,
            'outer_total_local_channel_attempts':fixture.budget.attempts,
            'dns_processes_in_this_fake_resolver_case':0,'native_or_account_used':False}
        assert (result['inner_owned_relay_descriptors'],result['outer_owned_relay_descriptors'])==(24,20)
    result['fd_count_restored']=descriptors()==before_fds
    result['threads_joined']=threading.active_count()==before_threads
    assert result['fd_count_restored'] and result['threads_joined']
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
