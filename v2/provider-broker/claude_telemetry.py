"""Closed non-authoritative native telemetry; selected-account data never forwarded."""
import math
from protocol import exact, require


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_telemetry(frame, input_uuid):
    if frame['type'] == 'command_lifecycle':
        exact(frame, ('type', 'session_id', 'uuid', 'command_uuid', 'state'))
        require(input_uuid is not None and frame['command_uuid'] == input_uuid)
        # Native command fate is metadata, including removal or failed turns.
        # None of these states is an interrupt acknowledgement or run terminal.
        require(frame['state'] in ('queued', 'started', 'completed',
                                   'cancelled', 'discarded', 'refused'))
        return
    exact(frame, ('type', 'session_id', 'uuid', 'rate_limit_info'))
    info = frame['rate_limit_info']
    require(isinstance(info, dict) and 'status' in info)
    require(set(info) <= {'status', 'resetsAt', 'rateLimitType', 'utilization',
        'overageStatus', 'overageResetsAt', 'overageDisabledReason',
        'isUsingOverage', 'unifiedWindows', 'overageInUse', 'overageEnabled',
        'surpassedThreshold', 'rateLimitGraceActive', 'overagePeriodMonthly',
        'overagePeriodChannel', 'limitScope', 'errorCode', 'canUserPurchaseCredits',
        'hasChargeableSavedPaymentMethod'})
    statuses = ('allowed', 'allowed_warning', 'rejected')
    require(info['status'] in statuses)
    for key in ('resetsAt', 'overageResetsAt', 'utilization', 'surpassedThreshold'):
        if key in info:
            require(number(info[key]))
    if 'rateLimitType' in info:
        require(info['rateLimitType'] in ('five_hour', 'seven_day', 'seven_day_opus',
                                        'seven_day_sonnet', 'seven_day_overage_included', 'overage'))
    if 'overageStatus' in info:
        require(info['overageStatus'] in statuses)
    if 'overageDisabledReason' in info:
        require(isinstance(info['overageDisabledReason'], str)
                and len(info['overageDisabledReason'].encode()) <= 256)
    # These native account/limit hints are discarded. They cannot enable billing,
    # retry, change credentials, acknowledge control, or supply a run terminal.
    for key in ('isUsingOverage', 'overageInUse', 'overageEnabled', 'rateLimitGraceActive',
                'canUserPurchaseCredits', 'hasChargeableSavedPaymentMethod'):
        if key in info:
            require(type(info[key]) is bool)
    if 'limitScope' in info:
        require(info['limitScope'] in ('service', 'channel', 'group_pool'))
    if 'errorCode' in info:
        require(info['errorCode'] == 'credits_required')
    for key in ('overagePeriodMonthly', 'overagePeriodChannel'):
        if key in info:
            exact(info[key], ('utilization',))
            require(number(info[key]['utilization']))
    if 'unifiedWindows' in info:
        windows = info['unifiedWindows']
        require(isinstance(windows, dict)
                and set(windows) <= {'five_hour', 'seven_day', 'seven_day_overage_included'})
        for window in windows.values():
            exact(window, ('utilization', 'resetsAt'))
            require(number(window['utilization']) and number(window['resetsAt']))
