"""Prepare fixed Fast/four-Worker profiles without invoking any executable."""
from closure import pin, require

NAMES = ("fast", "worker-0", "worker-1", "worker-2", "worker-3")


def entries(value):
    require(type(value) is dict and set(value) == {"fast", "workers"}, 'closed role plan required')
    require(type(value['workers']) is list and len(value['workers']) == 4, 'four worker slots required')
    return [('fast', value['fast']), *[(f'worker-{i}', item)
            for i, item in enumerate(value['workers'])]]


def validate(value, trust, uid, roots, preserve):
    result = {}
    for role, item in entries(value):
        require(type(item) is dict and set(item) == {'workspace', 'state_root'}, 'closed role paths required')
        workspace = trust.private(item['workspace'], uid, True)
        state = trust.private(item['state_root'], uid, True)
        for other in [roots[0], roots[1], *roots[3:]]:
            require(workspace != other and workspace not in other.parents and other not in workspace.parents,
                    'isolated role workspace overlap')
        require(preserve or not any(state.iterdir()), 'fresh role native state required')
        result[role] = (workspace, state)
    states = [state for _, state in result.values()]
    workspaces = [workspace for workspace, _ in result.values()]
    for index, state in enumerate(states):
        for other in [*states[index + 1:], *roots, *workspaces]:
            require(state != other and state not in other.parents and other not in state.parents,
                    'isolated role state overlap')
    return result


def emit(inner, paths, profile, gid, entry, write, encoded):
    roles = {'workers': []}
    for role in NAMES:
        workspace, state = paths[role]
        launcher = inner / f'launcher-{role}.py'
        write(launcher, entry(inner, 'broker-' + role), gid, True)
        write(inner / f'profile-{role}.json', encoded({**profile,
              'workspace': str(workspace), 'state_root': str(state)}), gid)
        value = {'launcher': str(launcher), 'launcher_sha256': pin(launcher)['sha256'],
                 'workspace': str(workspace)}
        if role == 'fast':
            roles['fast'] = value
        else:
            roles['workers'].append(value)
    return roles
