"""Pinned subscription telemetry is discarded, never execution or billing authority."""
import copy
import unittest
import uuid

from claude_telemetry import validate_telemetry
from claude_stream_schema import MAX_FRAME, MAX_RAW, frame_size
from protocol import Refused
import test_claude_control as control
import test_claude_telemetry as fixtures


def subscription_info():
    return {
        'status': 'allowed_warning', 'resetsAt': 123, 'utilization': 1.25,
        'rateLimitType': 'seven_day_overage_included',
        'overageStatus': 'allowed', 'overageResetsAt': 456,
        'overageDisabledReason': 'org_level_disabled_until',
        'isUsingOverage': False, 'overageInUse': False, 'overageEnabled': True,
        'surpassedThreshold': 0.95, 'rateLimitGraceActive': True,
        'unifiedWindows': {'five_hour': {'utilization': 1.25, 'resetsAt': 123},
                          'seven_day': {'utilization': 0.1, 'resetsAt': 456},
                          'seven_day_overage_included': {'utilization': 0, 'resetsAt': 789}},
        'overagePeriodMonthly': {'utilization': 0.2},
        'overagePeriodChannel': {'utilization': 0.3},
        'limitScope': 'group_pool', 'errorCode': 'credits_required',
        'canUserPurchaseCredits': False, 'hasChargeableSavedPaymentMethod': False,
    }


class ClaudeRateTelemetryTests(unittest.TestCase):
    setUp = fixtures.ClaudeTelemetryTests.setUp
    init = fixtures.ClaudeTelemetryTests.init
    request = fixtures.ClaudeTelemetryTests.request
    telemetry = fixtures.ClaudeTelemetryTests.telemetry

    def frame(self):
        frame = self.telemetry('rate_limit_event')
        frame['rate_limit_info'] = subscription_info()
        return frame

    def admit(self, ready=False):
        self.init(); self.channel.client(self.request(2))
        if ready:
            self.channel.provider({'type': 'system', 'subtype': 'init', 'session_id': self.native})

    def authority(self, channel=None):
        channel = channel or self.channel
        return (channel.initialized, channel.system_seen, channel.active, channel.input_uuid,
                channel.terminal, channel.terminal_uuid,
                None if channel.control is None else channel.control.ack,
                channel.stream.started if channel.stream is not None else False,
                frozenset(channel.output_uuids))

    def test_full_pinned_schema_is_discarded_before_native_init(self):
        self.admit(); before = self.authority(); frame = self.frame()
        self.assertIsNone(self.channel.provider(frame))
        self.assertEqual(self.authority(), before)
        self.assertFalse(self.channel.system_seen or self.channel.terminal)
        self.assertEqual(self.channel.wire_bytes, frame_size(frame) + 1)

    def test_each_new_field_is_independently_optional(self):
        for key, value in subscription_info().items():
            with self.subTest(key=key):
                frame = self.frame(); frame['rate_limit_info'] = {'status': 'allowed', key: value}
                self.assertIsNone(validate_telemetry(frame, self.channel.input_uuid))
        for scope in ('service', 'channel', 'group_pool'):
            frame = self.frame(); frame['rate_limit_info']['limitScope'] = scope
            self.assertIsNone(validate_telemetry(frame, self.channel.input_uuid))

    def test_all_metadata_states_leave_ack_and_terminal_evidence_separate(self):
        case = control.ClaudeControlTests(); case.setUp()
        case.channel.client(case.request())
        for status in ('allowed', 'allowed_warning', 'rejected'):
            before = self.authority(case.channel)
            frame = self.frame(); frame['session_id'] = case.channel.native
            frame['rate_limit_info']['status'] = status
            self.assertIsNone(case.channel.provider(frame))
            self.assertEqual(self.authority(case.channel), before)
        case.channel.provider(case.ack())
        self.assertFalse(case.channel.terminal)
        case.channel.provider(case.terminal())
        before = self.authority(case.channel)
        frame = self.frame(); frame['session_id'] = case.channel.native
        self.assertIsNone(case.channel.provider(frame))
        self.assertEqual(self.authority(case.channel), before)

    def test_new_boolean_fields_refuse_null_numeric_or_structural_values(self):
        for key in ('overageInUse', 'overageEnabled', 'rateLimitGraceActive',
                    'canUserPurchaseCredits', 'hasChargeableSavedPaymentMethod'):
            for value in (None, 0, 1, 'true', [], {}):
                with self.subTest(key=key, value=value):
                    frame = self.frame(); frame['rate_limit_info'][key] = value
                    with self.assertRaises(Refused): validate_telemetry(frame, None)

    def test_numeric_metadata_stays_finite_nonnegative_and_nonnullable(self):
        for value in (None, True, -1, '0.1', [], {}, float('inf'), float('-inf'), float('nan')):
            for key in ('surpassedThreshold', 'overagePeriodMonthly', 'overagePeriodChannel'):
                with self.subTest(key=key, value=value):
                    frame = self.frame()
                    frame['rate_limit_info'][key] = value if key == 'surpassedThreshold' else {'utilization': value}
                    with self.assertRaises(Refused): validate_telemetry(frame, None)
            frame = self.frame()
            frame['rate_limit_info']['unifiedWindows']['seven_day_overage_included']['resetsAt'] = value
            with self.assertRaises(Refused): validate_telemetry(frame, None)

    def test_nested_periods_and_windows_are_closed(self):
        for key in ('overagePeriodMonthly', 'overagePeriodChannel'):
            for value in (None, [], {}, {'utilization': 0, 'request': 'activate'}):
                frame = self.frame(); frame['rate_limit_info'][key] = value
                with self.assertRaises(Refused): validate_telemetry(frame, None)
        for value in ({'unknown_window': {'utilization': 0, 'resetsAt': 1}},
                      {'seven_day_overage_included': None},
                      {'seven_day_overage_included': {'utilization': 0}},
                      {'seven_day_overage_included': {'utilization': 0, 'resetsAt': 1, 'control': True}}):
            frame = self.frame(); frame['rate_limit_info']['unifiedWindows'] = value
            with self.assertRaises(Refused): validate_telemetry(frame, None)

    def test_new_enums_and_unknown_metadata_refuse(self):
        for key, value in (('rateLimitType', 'future_window'), ('limitScope', 'owner'),
                           ('limitScope', None), ('errorCode', 'purchase_credits'),
                           ('errorCode', None), ('request', {'subtype': 'interrupt'}),
                           ('account_environment', {'secret': 'synthetic'})):
            frame = self.frame(); frame['rate_limit_info'][key] = value
            with self.assertRaises(Refused): validate_telemetry(frame, None)

    def test_foreign_scope_and_authoritative_fields_poison_without_advancing(self):
        for key, value in (('session_id', str(uuid.uuid4())), ('subtype', 'init'),
                           ('result', 'synthetic'), ('terminal_reason', 'aborted_streaming'),
                           ('request', {'subtype': 'interrupt'})):
            self.setUp(); self.admit(); before = self.authority()
            frame = self.frame(); frame[key] = value
            with self.assertRaises(Refused): self.channel.provider(frame)
            self.assertTrue(self.channel.poisoned)
            self.assertEqual(self.authority(), before)

    def test_rate_metadata_cannot_initialize_submit_or_replay(self):
        with self.assertRaises(Refused): self.channel.provider(self.frame())
        self.assertFalse(self.channel.initialized or self.channel.system_seen)
        self.setUp(); self.admit(); frame = self.frame()
        self.channel.provider(frame); before = self.authority()
        with self.assertRaises(Refused): self.channel.client(self.request(3, 'message:2'))
        with self.assertRaises(Refused): self.channel.provider(copy.deepcopy(frame))
        self.assertEqual(self.authority(), before)

    def test_same_telemetry_identity_and_wire_budgets_apply(self):
        self.admit(); before = self.authority()
        for _ in range(128): self.assertIsNone(self.channel.provider(self.frame()))
        with self.assertRaises(Refused): self.channel.provider(self.frame())
        self.assertEqual(self.authority(), before)
        self.setUp(); self.admit(); before = self.authority()
        self.channel.wire_bytes = MAX_RAW - MAX_FRAME
        self.assertIsNone(self.channel.provider(self.frame(), raw_size=MAX_FRAME))
        with self.assertRaises(Refused): self.channel.provider(self.frame(), raw_size=1)
        self.assertEqual(self.authority(), before)


if __name__ == '__main__': unittest.main()
