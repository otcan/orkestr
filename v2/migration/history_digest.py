"""Core dormant-history-v1 binary source digest; no Store or apply authority."""
import hashlib
import uuid


def source_bytes(request):
    """Encode complete ordered Core history content, excluding namespace."""
    def identifier(value):
        parsed = uuid.UUID(value)
        if not parsed.int:
            raise ValueError('nil source identifier')
        return parsed.bytes

    def integer(value):
        if type(value) is not int or not 0 <= value <= (1 << 63) - 1:
            raise ValueError('invalid source integer')
        return value.to_bytes(8, 'big')

    messages = request['messages']
    if len(messages) > 100_000:
        raise ValueError('row limit')
    content = bytearray(b'orkestr-history-v1\0')
    content.extend(identifier(request['source_conversation_id']))
    scope = request['source_scope']
    if scope == {'kind': 'global'}:
        content.append(0)
    elif set(scope) == {'kind', 'project_id'} and scope['kind'] == 'project':
        content.append(1)
        content.extend(identifier(scope['project_id']))
    else:
        raise ValueError('unsupported scope')
    watermark = request['source_watermark']
    content.extend(integer(watermark))
    content.extend(integer(len(messages)))
    seen = set()
    last = 0
    for message in messages:
        message_id = identifier(message['message_id'])
        sequence = message['sequence']
        encoded_sequence = integer(sequence)
        if message_id in seen or not last < sequence <= watermark:
            raise ValueError('unordered or duplicated message')
        seen.add(message_id)
        last = sequence
        if message['actor_kind'] != 'owner':
            raise ValueError('unsupported actor')
        text = message['text'].encode('utf-8', errors='strict')
        if len(text) > 1024 * 1024:
            raise ValueError('text limit')
        content.extend(message_id)
        content.extend(encoded_sequence)
        for value in (b'owner', text):
            content.extend(integer(len(value)))
            content.extend(value)
        if len(content) > 16 * 1024 * 1024:
            raise ValueError('byte limit')
    return bytes(content)


def source_digest(request):
    """Hash the exact binary Core history encoding."""
    return hashlib.sha256(source_bytes(request)).hexdigest()
