"""In-memory stand-in for the owner API used by unit tests; the Rust server is
exercised end to end by acceptance/thread_history_e2e.py."""
import uuid

import archive_digest


class FakeV2:
    def __init__(self):
        self.conversations = {}
        self.keys = {}
        self.sources = {}
        self.calls = []
        self.native = {}
        self.lineage = {}

    def conversation(self):
        conversation = str(uuid.uuid4())
        self.conversations[conversation] = []
        return conversation

    def post(self, path, body):
        self.calls.append(('POST', path, len(body.get('messages', []))))
        if path == '/api/v2/conversations':
            key = body['client_request_id']
            if key not in self.keys:
                self.keys[key] = self.conversation()
            return {'conversation_id': self.keys[key], 'name': body['name']}
        conversation = path.split('/')[4]
        source = self.sources.setdefault((conversation, body['source_instance'], body['source_thread_id']), {
            'rows': {}, 'positions': {}, 'cursor': 0, 'checksum': '', 'quarantine': set()})
        inserted = duplicates = 0
        quarantined = []
        for message in body['messages']:
            digest = archive_digest.digest(message)
            known = source['rows'].get(message['source_message_id'])
            if known == digest:
                duplicates += 1
                continue
            if known:
                reason = 'content_changed'
            elif message['source_position'] in source['positions']:
                reason = 'position_conflict'
            elif message['source_position'] <= source['cursor']:
                reason = 'out_of_order'
            else:
                source['rows'][message['source_message_id']] = digest
                source['positions'][message['source_position']] = message
                source['cursor'] = message['source_position']
                source['checksum'] = archive_digest.chain_next(source['checksum'], digest)
                inserted += 1
                continue
            source['quarantine'].add((message['source_message_id'], digest, reason))
            quarantined.append({'source_message_id': message['source_message_id'],
                                'source_position': message['source_position'], 'reason': reason})
        return {'conversation_id': conversation, 'inserted': inserted, 'duplicates': duplicates,
                'quarantined': quarantined, 'source': None}

    def put(self, path, body):
        from v2_client import ApiError
        self.calls.append(('PUT', path, 0))
        conversation = path.split('/')[4]
        if (conversation, body['source_instance'], body['source_thread_id']) not in self.sources:
            raise ApiError(409, 'lineage_source_not_imported')
        known = self.lineage.get(conversation)
        if known is None:
            self.lineage[conversation] = dict(body)
            return 201, body
        if known == body:
            return 200, body
        raise ApiError(409, 'lineage_conflict')

    def get(self, path, query=None):
        self.calls.append(('GET', path, query))
        if path == '/api/v2/conversations':
            ids = sorted(self.conversations)
            return {'conversations': [{'conversation_id': c} for c in ids], 'next_cursor': None}
        parts = path.split('/')
        conversation = parts[4]
        if conversation not in self.conversations:
            from v2_client import ApiError
            raise ApiError(404, 'not_found')
        if path.endswith('/archived-history/status'):
            sources = []
            for (conv, instance, thread), source in self.sources.items():
                if conv == conversation:
                    sources.append({'source_instance': instance, 'source_thread_id': thread,
                                    'last_snapshot_id': 'x', 'cursor': source['cursor'],
                                    'message_count': len(source['rows']),
                                    'quarantined': len(source['quarantine']), 'checksum': source['checksum']})
            return {'conversation_id': conversation, 'sources': sources}
        return self.native_page(conversation, parts, query)

    def native_page(self, conversation, parts, query):
        native = self.native.get(conversation, {'inputs': [], 'replies': [], 'payloads': {}})
        if len(parts) == 5:
            rows = [m for m in native['inputs'] if m['sequence'] > query['after']]
            page = rows[:query['limit']]
            more = len(rows) > query['limit']
            return {'conversation_id': conversation, 'messages': page,
                    'last_sequence': 0, 'next_cursor': page[-1]['sequence'] if more else None}
        if parts[5] == 'accepted-results':
            rows = [r for r in native['replies'] if r['acceptance_sequence'] > query['after_sequence']]
            page = rows[:query['limit']]
            more = len(rows) > query['limit']
            return {'conversation_id': conversation, 'results': page,
                    'next_after_sequence': page[-1]['acceptance_sequence'] if more else None}
        if parts[5] == 'payloads':
            return {'payload_id': parts[6], 'text': native['payloads'].get(parts[6])}
        raise AssertionError(parts)
