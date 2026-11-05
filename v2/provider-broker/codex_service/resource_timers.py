"""Closed Core-written timer grants projected read-only to the native UID."""
from .contract import require

KIND = 'agent_timer_grants'


def selected(runtime, ctx):
    if KIND not in runtime:
        return None
    value = runtime[KIND]
    from .resource_contract import path, overlap
    require(type(value) is dict and set(value) == {'source', 'target'},
            'resource_timer_selection')
    source, target = path(value['source']), path(value['target'])
    require(ctx['provider_home'] in target.parents and not overlap(source, ctx['provider_home'])
            and not any(overlap(source, p) or overlap(target, p) for p in ctx['protected']),
            'resource_timer_scope')
    return value


def bind(row, ctx, homes):
    from .resource_contract import path, overlap
    value = ctx.get(KIND)
    require(value is not None and row['source'] == value['source']
            and row['target'] == value['target'] and row['uid'] == ctx['authority_uid']
            and row['gid'] == ctx['authority_gid'], 'resource_timer_binding')
    require(not any(overlap(path(row['source']), p) for p in homes),
            'resource_timer_external_source')


def private_mode(row, info):
    import stat
    if row['kind'] == KIND:
        require(stat.S_IMODE(info.st_mode) == 0o700, 'resource_timer_private_mode')
