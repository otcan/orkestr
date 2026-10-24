"""Passive quota projection: synthetic events only, no provider process."""
import fcntl
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from claude_quota import QuotaSink, project
import test_claude_telemetry as fixtures
from protocol import Refused

OWNER = '10000000-0000-4000-8000-000000000001'
ACCOUNT = '20000000-0000-4000-8000-000000000001'


class QuotaProjectionTests(unittest.TestCase):
    def test_two_account_windows_only_no_native_or_account_payload(self):
        result = project({'status':'allowed','account':{'email':'never-copied@example.invalid'},
            'access_token':'never-copied','unifiedWindows':{
                'five_hour':{'utilization':0.23,'resetsAt':2000000000},
                'seven_day':{'utilization':0.41,'resetsAt':2000600000},
                'seven_day_opus':{'utilization':0.99}}}, 1000)
        self.assertEqual(set(result), {'five_hour','seven_day'})
        self.assertEqual(result['five_hour']['used_percent'],23)
        self.assertEqual(result['seven_day']['used_percent'],41)
        self.assertNotIn('never-copied',json.dumps(result))
        self.assertEqual(project({'status':'allowed','unifiedWindows':{
            'seven_day_opus':{'utilization':0.99}}},1000),{})

    def test_status_is_not_an_invented_percentage_and_unknown_numbers_stay_unknown(self):
        value=project({'status':'rejected','rateLimitType':'five_hour','resetsAt':2000000000},1000)
        self.assertIsNone(value['five_hour']['used_percent'])
        self.assertEqual(value['five_hour']['status'],'rejected')
        for usage in (True,-1,1.1,float('inf'),float('nan'),'0.4',None):
            self.assertEqual(project({'status':'allowed','unifiedWindows':{
                'five_hour':{'utilization':usage}}},1000),{})

    def test_partial_events_keep_other_windows_original_observation_not_mtime(self):
        with tempfile.TemporaryDirectory() as root:
            sink=QuotaSink(root,OWNER,ACCOUNT,os.getuid())
            sink(OWNER,project({'unifiedWindows':{'seven_day':{'utilization':0.4}}},1000))
            sink(OWNER,project({'unifiedWindows':{'five_hour':{'utilization':0.2}}},2000))
            result=json.loads((Path(root)/'claude.json').read_text())
            self.assertEqual(result['windows']['seven_day']['observed_at'],1000)
            self.assertEqual(result['windows']['five_hour']['observed_at'],2000)
            self.assertEqual(result['owner_id'],OWNER)
            self.assertEqual(result['account_ref'],ACCOUNT)
            before=(Path(root)/'claude.json').read_bytes()
            sink(ACCOUNT,project({'unifiedWindows':{'five_hour':{'utilization':0.8}}},3000))
            self.assertEqual((Path(root)/'claude.json').read_bytes(),before)

    def test_unknown_current_usage_does_not_retimestamp_old_usage(self):
        with tempfile.TemporaryDirectory() as root:
            sink=QuotaSink(root,OWNER,ACCOUNT,os.getuid())
            sink(OWNER,project({'unifiedWindows':{'five_hour':{'utilization':0.4}}},1000))
            sink(OWNER,project({'rateLimitType':'five_hour','status':'allowed'},2000))
            value=json.loads((Path(root)/'claude.json').read_text())['windows']['five_hour']
            self.assertIsNone(value['used_percent'])
            self.assertEqual(value['observed_at'],2000)

    def test_symlinks_hardlinks_and_writable_directory_refuse(self):
        for kind in ('symlink','hardlink','directory'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as root:
                root=Path(root);outside=root/'unrelated';outside.write_text('unchanged')
                if kind=='symlink':(root/'claude.json').symlink_to(outside)
                elif kind=='hardlink':os.link(outside,root/'claude.json')
                else:root.chmod(0o770)
                with self.assertRaises((OSError,ValueError)):
                    QuotaSink(root,OWNER,ACCOUNT,os.getuid())(OWNER,project({'rateLimitType':'five_hour','status':'allowed'},1000))
                self.assertEqual(outside.read_text(),'unchanged')

    def test_busy_projection_lock_drops_metadata_without_waiting(self):
        with tempfile.TemporaryDirectory() as root:
            with open(Path(root)/'.quota.lock','w') as lock:
                os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    QuotaSink(root,OWNER,ACCOUNT,os.getuid())(OWNER,project({'rateLimitType':'five_hour','status':'allowed'},1000))

    def test_operator_binding_is_optional_and_cannot_share_private_core_state(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);directory=root/'quota';directory.mkdir(mode=0o750)
            package=SimpleNamespace(owner=OWNER,uid=os.getuid(),home=root/'home',root=root/'release',
                ledger_directory=root/'ledger',endpoint_directory=root/'endpoints',runtime={})
            self.assertIsNone(QuotaSink.optional(package))
            package.runtime={'claude_quota_projection':{'directory':str(directory),'account_ref':ACCOUNT}}
            self.assertIsInstance(QuotaSink.optional(package),QuotaSink)
            package.home=directory
            self.assertIsNone(QuotaSink.optional(package))


class QuotaChannelTests(unittest.TestCase):
    setUp=fixtures.ClaudeTelemetryTests.setUp
    init=fixtures.ClaudeTelemetryTests.init
    request=fixtures.ClaudeTelemetryTests.request
    telemetry=fixtures.ClaudeTelemetryTests.telemetry

    def test_callback_after_exact_validation_is_not_execution_authority(self):
        self.init();self.channel.client(self.request(2));calls=[]
        self.channel.quota_observer=lambda owner,windows:calls.append((owner,windows))
        before=(self.channel.initialized,self.channel.active,self.channel.system_seen,self.channel.terminal)
        frame=self.telemetry('rate_limit_event')
        frame['rate_limit_info']['account']={'email':'never-copied@example.invalid'}
        self.assertIsNone(self.channel.provider(frame))
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][0],self.channel.owner_id)
        self.assertNotIn('never-copied',json.dumps(calls))
        self.assertEqual(before,(self.channel.initialized,self.channel.active,self.channel.system_seen,self.channel.terminal))
        with self.assertRaises(Refused):self.channel.provider(frame)
        self.assertEqual(len(calls),1,'duplicate rejected before observation')

    def test_sink_error_cannot_fail_renew_or_complete_a_turn(self):
        self.init();self.channel.client(self.request(2))
        def broken(_owner,_windows):raise PermissionError('synthetic cache failure')
        self.channel.quota_observer=broken
        before=(self.channel.initialized,self.channel.active,self.channel.system_seen,self.channel.terminal)
        self.assertIsNone(self.channel.provider(self.telemetry('rate_limit_event')))
        self.assertFalse(self.channel.poisoned)
        self.assertEqual(before,(self.channel.initialized,self.channel.active,self.channel.system_seen,self.channel.terminal))

    def test_stop_control_refusal_is_not_swallowed_as_a_cache_error(self):
        self.init();self.channel.client(self.request(2))
        def stopped(_owner,_windows):raise Refused('synthetic stop')
        self.channel.quota_observer=stopped
        with self.assertRaises(Refused):self.channel.provider(self.telemetry('rate_limit_event'))
