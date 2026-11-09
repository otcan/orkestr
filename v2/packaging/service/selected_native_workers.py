"""Explicit Native Worker rollout selection; no default activation or host action."""
from closure import require


def runtime(plan):
    if 'managed_workers' not in plan:
        return {}
    require('authority_uid' in plan and plan.get('managed_operations') is True
            and plan['managed_workers'] is True,
            'closed split Native Worker configuration required')
    return {'managed_workers': True}
