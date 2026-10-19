"""Offline legacy evidence publication. No live store/lock adoption operations.

The coordinated cohort implementation must provide ``seal(raw, source_digest)``
and return validated output bytes plus external adoption receipt bytes. This
module deliberately has no permissive fallback or self-authorizing JSON marker.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from desktop_restore import (MAX_BYTES, PublicationUnknown, RecoveryError,
                             finite_float, no_duplicates, private_parent,
                             read_original, rename_fresh)


def strict_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=no_duplicates, parse_float=finite_float,
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              RecoveryError('nonfinite JSON')))
    except (ValueError, UnicodeError) as error:
        raise RecoveryError('invalid JSON evidence') from error


def prepare_bundle(source, target, digest, seal, *, offline_confirmed=False,
                   hook=lambda phase: None, provenance=None):
    """Publish only a fresh evidence directory after trusted cohort sealing.

    ``seal`` is trusted reviewed code, not a module selected by source state.
    It owns the exact canonicalization/retired-cohort contract and must reject
    every malformed legacy field. Its receipt remains external to leases.json;
    possession of either file alone is not authority to activate a live store.
    """
    if not offline_confirmed:
        raise RecoveryError('explicit offline source confirmation required; age is not quiescence')
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise RecoveryError('explicit source SHA256 required')
    source, target = Path(source), Path(target)
    private_parent(source.parent)
    private_parent(target.parent)
    if source.name in ('', '.', '..') or target.name in ('', '.', '..') or os.path.lexists(target):
        raise RecoveryError('fresh target required')
    raw = read_original(source)
    if hashlib.sha256(raw).hexdigest() != digest:
        raise RecoveryError('source digest mismatch')
    state = strict_json(raw)
    if not isinstance(state, dict) or 'lockIdentity' in state:
        raise RecoveryError('legacy source without embedded lock identity required')
    # No staging or publication before the shared validator contract succeeds.
    output, adoption = seal(raw, digest)
    for data in (output, adoption):
        if not isinstance(data, bytes) or not data or len(data) > MAX_BYTES:
            raise RecoveryError('bounded sealed JSON bytes required')
        strict_json(data)
    # Transport evidence is separate from the externally trusted adoption
    # receipt. It does not invent that receipt's schema or duplicate its trust.
    transport = dict(format='desktop-legacy-evidence-bundle-v1',
                     source_sha256=digest,
                     output_sha256=hashlib.sha256(output).hexdigest(),
                     adoption_sha256=hashlib.sha256(adoption).hexdigest(),
                     activation='not-performed; external-trusted-adoption-required')
    if provenance is not None:
        transport['preparationSource'] = provenance
    metadata = (json.dumps(transport, indent=2, allow_nan=False) + '\n').encode()
    if len(metadata) > MAX_BYTES:
        raise RecoveryError('transport metadata exceeds bound')
    strict_json(metadata)
    stage = Path(tempfile.mkdtemp(prefix='.desktop-legacy-', dir=target.parent))
    publishing = False
    try:
        for name, data in [('original.json', raw), ('leases.json', output),
                           ('adoption.json', adoption), ('bundle.json', metadata)]:
            with open(stage / name, 'xb') as file:
                os.chmod(stage / name, 0o600)
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
        directory = os.open(stage, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        hook('prepared')
        publishing = True
        rename_fresh(stage, target)
        hook('published')
        directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        publishing = False
        return transport
    except BaseException as error:
        if publishing:
            raise PublicationUnknown('legacy publication uncertain; retain evidence; do not retry or activate') from error
        raise
    finally:
        if not publishing and stage.exists():
            shutil.rmtree(stage)
