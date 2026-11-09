"""Bounded Native Worker task data; caller authority comes from managed ingress."""
from .contract import canonical, identifier, require

ARGUMENT_BYTES = 4096
INSTRUCTION_BYTES = 4096
NAMES = {
    'orkestr_worker_capability': 'worker_capability',
    'orkestr_worker_submit': 'worker_submit',
    'orkestr_worker_status': 'worker_status',
    'orkestr_worker_wait': 'worker_wait',
}


def advertisements():
    empty = {'type': 'object', 'properties': {}, 'additionalProperties': False}
    task = {'type': 'object', 'properties': {
        'task_id': {'type': 'string', 'format': 'uuid'}},
        'required': ['task_id'], 'additionalProperties': False}
    submit = {'type': 'object', 'properties': {
        'title': {'type': 'string', 'minLength': 1, 'maxLength': 160},
        'instructions': {'type': 'string', 'minLength': 1, 'maxLength': INSTRUCTION_BYTES}},
        'required': ['title', 'instructions'], 'additionalProperties': False}
    descriptions = {
        'orkestr_worker_capability': ('Read current scoped Worker availability, configured limits and capability state. '
            'Registration alone does not establish an available scheduler.'),
        'orkestr_worker_submit': ('Create one bounded Core Worker task under this actual primary run and wait '
            'for its result up to 25 seconds. Keep the complete UTF-8 arguments within 4 KiB. A queued receipt is not a running Worker. '
            'For an unfinished task use orkestr_worker_wait; never resubmit an unknown outcome.'),
        'orkestr_worker_status': 'Read the actual phase and result of a Worker task belonging to this primary run.',
        'orkestr_worker_wait': ('Wait within the observation deadline for this primary run\'s existing task. '
            'This does not create or re-execute a task. Report the returned actual phase.')}
    return [{'name': name, 'description': descriptions[name],
        'inputSchema': empty if name.endswith('_capability') else submit if name.endswith('_submit') else task,
        'annotations': {'readOnlyHint': name != 'orkestr_worker_submit',
            'destructiveHint': name == 'orkestr_worker_submit',
            'idempotentHint': name != 'orkestr_worker_submit', 'openWorldHint': name == 'orkestr_worker_submit'}}
        for name in NAMES]


def validate(operation, arguments):
    require(operation in NAMES.values() and type(arguments) is dict, 'managed_worker_arguments')
    # Leave room for the protected source and control envelope under the
    # existing 8 KiB control-frame bound; do not raise a transport ceiling.
    require(len(canonical(arguments)) <= ARGUMENT_BYTES, 'managed_worker_arguments_bound')
    if operation == 'worker_capability':
        require(not arguments, 'managed_worker_capability_fields')
    elif operation == 'worker_submit':
        require(set(arguments) == {'title', 'instructions'}, 'managed_worker_submit_fields')
        title, instructions = arguments['title'], arguments['instructions']
        require(type(title) is str and title.strip() and len(title.encode()) <= 160
                and not any(ord(c) < 32 or ord(c) == 127 for c in title), 'managed_worker_title')
        require(type(instructions) is str and instructions.strip()
                and len(instructions.encode()) <= INSTRUCTION_BYTES and '\0' not in instructions,
                'managed_worker_instructions')
    else:
        require(set(arguments) == {'task_id'}, 'managed_worker_task_fields')
        identifier(arguments['task_id'])
    return arguments
