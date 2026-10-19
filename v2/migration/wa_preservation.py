"""Independent evidence assertions, not an importer, queue or canonical Core DTO.

Source identities are opaque and must remain private for actual deployments.
The public fixture is synthetic. This module opens no authority or socket.
"""
import argparse
import json
from pathlib import Path
import re
import uuid

EFFECTS = {'sent', 'sending', 'uncertain', 'unknown', 'no_record'}
REASONS = {'operator_preserved', 'uncertain_effect', 'unknown_effect'}


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def availability(value, kind):
    require(isinstance(value, dict) and set(value) == {'availability', 'value'}, 'availability shape')
    if value['availability'] == 'unknown':
        require(value['value'] is None, 'unknown must have no value')
    else:
        require(value['availability'] == 'known', 'availability state')
        if kind == 'revision':
            require(isinstance(value['value'], str) and re.fullmatch('[0-9a-f]{64}', value['value']), 'revision')
        else:
            require(type(value['value']) is int and 0 <= value['value'] <= 2**64-1, 'route generation')


def validate_source(source):
    require(isinstance(source, dict) and set(source) == {'source_namespace', 'route_cutoff', 'inputs'}, 'source shape')
    require(uuid.UUID(source['source_namespace']).int != 0, 'source namespace')
    require(isinstance(source['route_cutoff'], str), 'cutoff metadata')
    require(isinstance(source['inputs'], list) and len(source['inputs']) <= 128, 'input cap')
    seen = set()
    for row in source['inputs']:
        require(set(row) == {'source_input_identity', 'created_at', 'source_revision', 'historical_effects', 'hold', 'source_route_generation'}, 'input shape')
        identity = row['source_input_identity']
        require(isinstance(identity, str) and 0 < len(identity.encode()) <= 512 and not any(ord(c)<32 or 127<=ord(c)<=159 for c in identity), 'opaque identity')
        require(identity not in seen, 'duplicate identity'); seen.add(identity)
        require(isinstance(row['created_at'], str), 'timestamp metadata')
        availability(row['source_revision'], 'revision')
        availability(row['source_route_generation'], 'generation')
        require(set(row['hold']) == {'reason', 'source_revision'} and row['hold']['reason'] in REASONS, 'hold provenance')
        availability(row['hold']['source_revision'], 'revision')
        require(isinstance(row['historical_effects'], list) and 0 < len(row['historical_effects']) <= len(EFFECTS), 'effect evidence')
        states = set()
        for effect in row['historical_effects']:
            require(set(effect) == {'classification', 'count'}, 'effect shape')
            require(effect['classification'] in EFFECTS and effect['classification'] not in states, 'effect classification')
            states.add(effect['classification'])
            require(type(effect['count']) is int and 0 <= effect['count'] <= 2**64-1, 'effect count')


def assert_preserved(source, evidence):
    """Check a candidate evidence projection; never generate or apply an import."""
    validate_source(source)
    require(isinstance(evidence, dict) and set(evidence) == {'source_namespace', 'holds', 'automatic_reply_enabled', 'skill_only_routing_enabled'}, 'target evidence shape')
    require(evidence['source_namespace'] == source['source_namespace'], 'namespace changed')
    require(evidence['automatic_reply_enabled'] is False, 'imported automatic authority')
    require(evidence['skill_only_routing_enabled'] is False, 'skill-only routing')
    require(isinstance(evidence['holds'], list) and len(evidence['holds']) == len(source['inputs']), 'hold completeness')
    by_id = {}
    for held in evidence['holds']:
        require(set(held) == {'provenance', 'state', 'replay_policy'}, 'hold evidence shape')
        require(held['state'] == 'dormant' and held['replay_policy'] == 'never_replay', 'runnable preserved history')
        identity = held['provenance']['source_input_identity']
        require(identity not in by_id, 'duplicate preserved hold')
        by_id[identity] = held['provenance']
    for row in source['inputs']:
        # Full provenance equality preserves mixed sent/uncertain evidence,
        # original count, timestamp, hold revision and unknown route generation.
        require(by_id.get(row['source_input_identity']) == row, 'lost or changed provenance')
    return {'preserved_holds': len(by_id), 'automatic_authority': False,
            'scope': 'evidence assertions only; Core apply/reservation unexecuted'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixture', type=Path)
    args = parser.parse_args()
    value = json.loads(args.fixture.read_text())
    print(json.dumps(assert_preserved(value['source'], value['preserved'])))


if __name__ == '__main__':
    main()
