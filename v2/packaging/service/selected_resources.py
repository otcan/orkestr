"""Enter only the selected source's Root resource view during full staging."""
from contextlib import nullcontext
from pathlib import Path
from closure import require


def timer_grants(plan):
    """Metadata-only shape/scope checks before any selected artifact is read."""
    if 'agent_timer_grants' not in plan:
        return
    value=plan['agent_timer_grants']
    require('resource_namespace' in plan and 'authority_uid' in plan
            and type(plan.get('provider_home')) is str
            and type(value) is dict and set(value)=={'source','target'},
            'timer grants require selected split resource namespace')
    for item in value.values():
        require(type(item) is str and item.startswith('/') and item!='/'
                and len(item)<=4096 and not any(ord(c)<32 for c in item)
                and all(part not in ('','.','..') for part in item.split('/')[1:]),
                'normalized timer grant path required')
    source,target=Path(value['source']),Path(value['target'])
    def overlap(a,b):return a==b or a in b.parents or b in a.parents
    provider=Path(plan['provider_home'])
    require(provider in target.parents and not overlap(source,provider),
            'timer grant reader must be inside provider home')
    for key in ('home','bootstrap_file','ledger_directory','endpoint_directory','output'):
        other=Path(plan[key])
        require(not overlap(source,other) and not overlap(target,other),
                'timer grant authority scope overlap')


def view(plan, manager):
    if 'resource_namespace' not in plan:
        return nullcontext()
    require('codex_service/resource_namespace.py' in manager.FILES,
            'selected source does not support resource namespaces')
    from codex_service.resource_contract import context
    from codex_service.resource_namespace import Activation
    ctx = context(plan, plan, {'auth_file': plan['auth_file']}, plan.get('claude'),
                  Path(plan['output']) / 'package')
    return Activation(plan['resource_namespace'], ctx)
