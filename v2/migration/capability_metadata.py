"""Pure validator for the source-defined personal-agent capability response.

No HTTP, authentication, environment, registry or database access occurs here.
Only an already-authorized response may be supplied. Extra fields fail closed.
"""
from snapshot import Invalid


def personal_agent_observation(response):
    """Return one fixed observation, never a usage or external-memory claim."""
    if type(response) is not dict:
        raise Invalid('capability response must be an object')
    enabled = response.get('enabled')
    capability = response.get('capability')
    if type(enabled) is not bool or type(capability) is not bool:
        raise Invalid('capability flags must be booleans')
    if response.get('assistant') != {'available': False, 'reason': 'not_configured'}:
        raise Invalid('unsupported assistant capability')
    # Equality alone would accept 0 as False; check the nested type as well.
    if type(response['assistant']) is not dict or type(response['assistant'].get('available')) is not bool:
        raise Invalid('unsupported assistant capability')
    if not enabled and not capability:
        state, reason = 'disabled', 'disabled'
    elif enabled and not capability:
        state, reason = 'storage_unavailable', 'storage_unavailable'
    elif enabled and capability:
        state, reason = 'available', None
    else:
        raise Invalid('inconsistent capability flags')
    expected = {'enabled', 'capability', 'assistant'}
    if reason is not None:
        expected.add('reason')
        if response.get('reason') != reason:
            raise Invalid('unsupported capability reason')
    if set(response) != expected:
        raise Invalid('unexpected capability fields')
    return {'format_version': 1, 'authority': 'personal-agent-capability',
            'coverage': 'partial', 'observation_count': 1,
            'buckets': {key: int(key == state) for key in
                        ('disabled', 'storage_unavailable', 'available')},
            'meaning': 'configuration and required-table availability only; not usage',
            'cross_store_consistency': False}
