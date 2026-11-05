"""Enter only the selected source's Root resource view during full staging."""
from contextlib import nullcontext
from pathlib import Path
from closure import require


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
