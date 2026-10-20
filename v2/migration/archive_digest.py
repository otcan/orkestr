"""Archived message identity digest; must match store-sqlite archived_history/digest.rs."""
import hashlib

PREFIX = b'orkestr-archived-message-v1\0'


def _string(out, value):
    data = value.encode('utf-8')
    out += len(data).to_bytes(8, 'big')
    out += data


def _optional(out, value):
    if value is None:
        out.append(0)
    else:
        out.append(1)
        _string(out, value)


def canonical(message):
    out = bytearray(PREFIX)
    _string(out, message['source_message_id'])
    out += int(message['source_position']).to_bytes(8, 'big', signed=True)
    _string(out, message['role'])
    _optional(out, message.get('phase'))
    _optional(out, message.get('created_at'))
    _string(out, message['text'])
    attachments = message.get('attachments') or []
    out += len(attachments).to_bytes(8, 'big')
    for attachment in attachments:
        _string(out, attachment['name'])
        _string(out, attachment['sha256'])
        out += int(attachment['bytes']).to_bytes(8, 'big')
        _optional(out, attachment.get('media_type'))
        out.append(1 if attachment['available'] else 0)
    return bytes(out)


def digest(message):
    return hashlib.sha256(canonical(message)).hexdigest()


def chain_next(previous, message_digest):
    return hashlib.sha256(f'{previous}:{message_digest}'.encode('ascii')).hexdigest()


def checksum(messages):
    """Chain over messages already sorted by source position."""
    value = ''
    for message in messages:
        value = chain_next(value, digest(message))
    return value
