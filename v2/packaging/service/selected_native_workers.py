"""Explicit Native Worker rollout selection; no default activation or host action."""
from closure import require


def runtime(plan):
    if 'managed_workers' not in plan and 'managed_worker_execution_budget_ms' not in plan:
        return {}
    require('authority_uid' in plan and plan.get('managed_operations') is True
            and plan.get('managed_workers') is True,
            'closed split Native Worker configuration required')
    value={'managed_workers': True}
    if 'managed_worker_execution_budget_ms' in plan:
        budget=plan['managed_worker_execution_budget_ms']
        require(type(budget) is int and 30000<=budget<=3600000,'bounded Native Worker budget required')
        value['managed_worker_execution_budget_ms']=budget
    return value
