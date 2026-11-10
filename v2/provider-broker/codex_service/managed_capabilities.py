"""Conversation-scoped discovery of the tools on the managed MCP surface.

Registration is evidence that an operation can be requested, never Core
authorization or evidence that a business action will succeed. Other surfaces
are deliberately outside this incremental manifest's coverage.
"""
from .contract import identifier, require
from .managed_ingress import MAX_CONNECTIONS, MAX_WINDOW_REQUESTS
from .managed_workers import NAMES

NAME = 'orkestr_capabilities'
HTTP_REQUESTS_MAX = 128


def advertisement():
    return {'name': NAME, 'description':
        'Read the current conversation\'s versioned managed-tool manifest. '
        'Reports registered tools, setup guidance and limits; grants no authority. '
        'Other tool surfaces are outside its coverage.',
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        'annotations': {'readOnlyHint': True, 'destructiveHint': False,
                        'idempotentHint': True, 'openWorldHint': False}}


def manifest(scope, registered):
    """Project an already authenticated scope and this request's tools/list.

    Copy only fixed tool names, never descriptions, input schemas, operation
    identifiers, host paths, credentials or the rest of the native's identity.
    """
    conversation = identifier(scope['conversation_id'])
    provider = scope['provider']
    require(provider in ('codex', 'claude'), 'managed_capability_provider')
    names = [tool['name'] for tool in registered]
    known = {NAME, 'orkestr_desk_login', 'orkestr_root_request_submit', *NAMES}
    require(len(names) == len(set(names)) and set(names) <= known
            and NAME in names, 'managed_capability_registry')
    capabilities = []
    for name, operation in ((NAME, 'discover'),
                            ('orkestr_desk_login', 'request_scoped_login'),
                            ('orkestr_root_request_submit', 'submit_for_owner_review')):
        present = name in names
        capabilities.append({'tool': name,
            'status': 'ready' if present else 'setup_required',
            'operations': [operation] if present else [],
            'setup_action': None if present else 'Ask the owner to configure this scoped tool.',
            'requires_operation_authorization': name != NAME})
    return {'schema_version': 1, 'conversation_id': conversation,
        'surface': 'managed_mcp', 'complete': False, 'freshness': 'per_request',
        'readiness_basis': 'registered_tools',
        'provider': provider, 'capabilities': capabilities,
        'native_timers': {'status': 'unassessed',
            'reason': 'authoritative_core_observation_unavailable',
            'operations': [], 'requires_operation_authorization': True,
            'setup_action': 'Use the owner-authenticated Core timer capability observation; this managed surface has no trusted bridge yet.'},
        'registered_tools': names,
        'limits': {'http_requests_per_native_max': HTTP_REQUESTS_MAX,
                   'operation_requests_per_window_max': MAX_WINDOW_REQUESTS,
                   'concurrent_connections_max': MAX_CONNECTIONS,
                   'requires_live_original_native': True,
                   'requires_service_uptime': True},
        'uncovered': ['native_timers', 'delivery', 'managed_browser',
                      'files_workspace_git', 'provider_availability', 'delegated_workers']}
