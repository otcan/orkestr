"""Read build identity without executing artifacts. Integrity, not build attestation."""
import re

PREFIX = b'ORKESTR_V2_BUILD_IDENTITY_V1|'
PATTERN = re.compile(rb'ORKESTR_V2_BUILD_IDENTITY_V1\|(server|web)\|(2\.0\.0-(?:dev|rc\.[1-9][0-9]*))\|([0-9a-f]{40})\|END')
VERSION = re.compile(r'2\.0\.0-(?:dev|rc\.[1-9][0-9]*)')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def record(component, version, source):
    require(component in ('server', 'web') and VERSION.fullmatch(version) and
            re.fullmatch(r'[0-9a-f]{40}', source), 'valid embedded build identity required')
    return f'ORKESTR_V2_BUILD_IDENTITY_V1|{component}|{version}|{source}|END'


def read(path, component, version, source):
    blob = path.read_bytes()
    matches = list(PATTERN.finditer(blob))
    # Repeated identical records can occur in compiler data sections. Conflicting
    # or malformed records fail closed, including explicit unknown local builds.
    require(len(matches) == blob.count(PREFIX) and bool(matches), 'missing or malformed embedded build identity')
    expected = record(component, version, source).encode('ascii')
    require(all(match.group() == expected for match in matches), 'embedded build identity mismatch')
    return {'format': 'orkestr-v2-build-identity-v1', 'component': component,
            'version': version, 'source_commit': source}


def verify(binary, ui, version, source):
    server = read(binary, 'server', version, source)
    wasm = sorted(ui.rglob('*.wasm'))
    require(len(wasm) == 1, 'one compiled web WASM identity required')
    web = read(wasm[0], 'web', version, source)
    return {'server': server, 'web': web}
