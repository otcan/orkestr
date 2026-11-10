"""Bounded collector for published ConversationSnapshot pages; no live I/O.

Does not invent a dormant store API or claim coherent multi-authority export.
Caller supplies pages already obtained through an authorized read adapter.
"""
from copy import deepcopy
import uuid
from snapshot import fields, need, canonical, sha

MAX_PAGES = 1000
MAX_BYTES = 16 * 1024 * 1024
I64_MAX = (1 << 63) - 1


def _sequence(value):
    return type(value) is int and 0 <= value <= I64_MAX


def _id(value):
    need(isinstance(value, str), 'invalid_export_id')
    try:
        need(str(uuid.UUID(value)) == value, 'noncanonical_export_id')
    except ValueError:
        need(False, 'invalid_export_id')


def collect_pages(pages):
    """Return (assembled published snapshot, deterministic digest), or fail closed.

    Every input page must have been requested from cursor zero then the preceding
    next_cursor, using the same authorized owner/conversation. Page contents do
    not independently prove that authorization, completeness or a consistent cut.
    """
    first = None
    messages, seen = [], set()
    after, total_bytes = 0, 0
    complete = False
    for number, supplied in enumerate(pages, 1):
        need(number <= MAX_PAGES and not complete, 'export_page_bound_or_trailing_page')
        page = deepcopy(supplied)
        fields(page, ('conversation_id', 'scope', 'messages', 'last_sequence', 'next_cursor'))
        _id(page['conversation_id'])
        scope = page['scope']
        need(isinstance(scope, dict), 'invalid_export_scope')
        if scope.get('kind') == 'project':
            fields(scope, ('kind', 'project_id')); _id(scope['project_id'])
        else:
            fields(scope, ('kind',)); need(scope['kind'] == 'global', 'invalid_export_scope')
        need(_sequence(page['last_sequence']), 'invalid_export_watermark')
        if first is None:
            first = page
        else:
            need(all(page[k] == first[k] for k in ('conversation_id', 'scope', 'last_sequence')),
                 'export_cut_or_authority_changed')
        need(isinstance(page['messages'], list) and len(page['messages']) <= 100, 'export_page_size')
        for message in page['messages']:
            fields(message, ('message_id', 'sequence', 'actor_kind', 'text'))
            _id(message['message_id'])
            need(message['message_id'] not in seen, 'duplicate_export_message')
            sequence = message['sequence']
            need(_sequence(sequence) and after < sequence <= page['last_sequence'], 'export_message_order')
            need(isinstance(message['actor_kind'], str) and isinstance(message['text'], str), 'export_message_shape')
            after = sequence
            seen.add(message['message_id'])
            messages.append(message)
        cursor = page['next_cursor']
        if cursor is None:
            complete = True
        else:
            need(_sequence(cursor) and page['messages'] and cursor == after
                 and cursor < page['last_sequence'], 'export_cursor_invalid')
        total_bytes += len(canonical(page))
        need(total_bytes <= MAX_BYTES, 'export_byte_bound')
    need(first is not None and complete, 'export_incomplete')
    result = {**first, 'messages': messages, 'next_cursor': None}
    return result, sha(result)
