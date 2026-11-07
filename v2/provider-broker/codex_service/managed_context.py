"""Provider-neutral application instructions, without deployment-owned prompts.

The same versioned rules accompany MCP initialization and each fresh capability
read. Registration and these instructions never grant operation authority.
"""


def instructions():
    return {'schema_version': 1, 'application': 'orkestr', 'scope': 'current_conversation',
        'rules': [
            'Use the current conversation capability manifest to choose registered managed tools.',
            'Ready means a tool is registered; each business operation still requires its existing authorization.',
            'Call orkestr_capabilities when starting new work, after resuming a session, and after setup or permission changes. Initialization is a snapshot.',
            'Use only this authenticated conversation. Do not borrow operation identifiers, grants or authority from another conversation or an earlier session.',
            'Submitting a request for owner review does not approve it or authorize its execution.',
            'Keep Fast read-only and Workers within their delegated scope. Provider choice does not change those boundaries.',
            'The uncovered capability surfaces have not been assessed here; discover them through their own authorized interfaces.'
        ]}
