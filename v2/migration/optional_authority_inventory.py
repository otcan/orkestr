"""Pure evidence classification; never opens a connector or copies its payload."""


def classify(authority, *, http_status=None, enabled=None, capability=None,
             configured=False, scope_verified=False):
    """Fixed output vocabulary. Configuration and refusal never prove non-use.

    A successful scoped status establishes only capability, not workflow activity.
    Inputs are already projected metadata; no raw response is retained.
    """
    if authority not in ('memory', 'google_workspace', 'oxrm'):
        raise ValueError('unsupported authority')
    if type(configured) is not bool or type(scope_verified) is not bool:
        raise ValueError('invalid metadata flags')
    if http_status is not None and (type(http_status) is not int or not 100 <= http_status <= 599):
        raise ValueError('invalid HTTP status')
    if any(value is not None and type(value) is not bool for value in (enabled, capability)):
        raise ValueError('invalid capability flags')
    state = 'configured_unverified' if configured else 'unresolved'
    if http_status == 401:
        state = 'authentication_required'
    elif http_status == 403:
        state = 'caller_refused'
    elif http_status == 404:
        state = 'route_or_scope_unresolved'
    elif http_status == 200:
        if not scope_verified:
            state = 'scope_unverified'
        elif enabled is False:
            state = 'disabled_in_observed_scope'
        elif capability is False:
            state = 'capability_unavailable_in_observed_scope'
        elif capability is True:
            state = 'capability_reported_in_observed_scope'
        else:
            state = 'status_shape_unresolved'
    return {'authority': authority, 'state': state, 'preserve_required': True,
            'activity_proven': False, 'credential_migration_allowed': False}
