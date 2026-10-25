"""Export only observed layer identities and explicit same-ledger input links."""
import re
import uuid

IDENTITY_FIELDS = ('provider', 'model', 'layer', 'runId', 'identitySource', 'observedReasoningEffort', 'sourceInputId')


def canonical_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value and uuid.UUID(value).int != 0
    except ValueError:
        return False


def attach_scope(message, data):
    if message.get('sourceInputId') or data.get('post'):
        return
    original = (data.get('first_response_for') or {}).get('input_id') or data.get('remote_id')
    if canonical_uuid(original):
        message['sourceInputId'] = original


def post_identity(db, record, identity=None):
    # A native question is already pinned to its exact producing run. External
    # posts instead name their own provider/model; never borrow the native Deep.
    if record.get('author') == 'assistant_question':
        result = {k:v for k,v in (identity or {}).items() if k in IDENTITY_FIELDS and v}
        if canonical_uuid(record.get('sourceInputId')):
            result['sourceInputId'] = record['sourceInputId']
        return result
    result = {k:record[k] for k in ('provider', 'model') if record.get(k)}
    result['identitySource'] = 'post'
    if record.get('author') == 'coordinator':
        result['layer'] = 'coordinator'
    match = re.fullmatch(r'coordinator-input:([0-9a-f-]{36}):answer', record.get('request_key') or '')
    if match and canonical_uuid(match[1]):
        row = db.execute('SELECT remote_id FROM inputs WHERE public_id=?', (match[1],)).fetchone()
        if row and canonical_uuid(row[0]):
            result['sourceInputId'] = row[0]
    return result
