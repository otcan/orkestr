"""Fetch only the official pinned Linux x86_64/aarch64 CLI artifacts; never log in."""
import base64
import hashlib
import io
from pathlib import Path
import platform
import tarfile
import time
from types import MappingProxyType
import urllib.error
import urllib.request

CODEX = 'https://github.com/openai/codex/releases/download/rust-v0.163.0/'
CLAUDE = 'https://registry.npmjs.org/@anthropic-ai/'
# Pins per Linux machine (uname -m inside the build container). Each entry is the
# official release asset for that architecture with its published digest.
ASSETS = {
    'x86_64': (
        ('codex', CODEX + 'codex-x86_64-unknown-linux-musl.tar.gz',
         'sha256', 'beb339e8ecd9ba057a6bb2dc81ad8ca474812edfbf0fc5056ca818797648dde4'),
        ('codex-code-mode-host', CODEX + 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
         'sha256', '314263128ba6592e7e807c265deeaf928a692b72dcbfeb5e0b20c9423b703529'),
        ('claude', CLAUDE + 'claude-code-linux-x64/-/claude-code-linux-x64-2.1.295.tgz',
         'sha512', base64.b64decode('nC9RZ6ZArEavyAiFdEtGK6/XPhjfE79tP2tCh+PjmRUxSO/6W3IuXv/rmo8c6u2UzHyvgKodRj1z6UcBGlbnyA==').hex()),
    ),
    'aarch64': (
        ('codex', CODEX + 'codex-aarch64-unknown-linux-musl.tar.gz',
         'sha256', 'a7261e65f4a96d8f4ca65a069c6cf2dc2c33defc341e48078acefda9461fffe4'),
        ('codex-code-mode-host', CODEX + 'codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz',
         'sha256', '284356aefb197f00b76b912efdfdbae8ccf3ea1f89b976dde064b7ccb43214ef'),
        ('claude', CLAUDE + 'claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.295.tgz',
         'sha512', base64.b64decode('JgQigCZCbsTnJQMLBjzeIpx001jlw+QlSR08SsAW7p0hjUR73DczX4NpO2lq/+RPm8w48KhM8DxJqhUmAMV5+Q==').hex()),
    ),
}
# ELF e_machine of each supported architecture (little-endian, 64-bit).
ELF_MACHINE = {'x86_64': b'\x3e\x00', 'aarch64': b'\xb7\x00'}
# Exact official release assets for the unchanged URLs/digests above. The API
# route avoids the browser-download endpoint; no token or runtime lookup is used.
GITHUB_ASSET_IDS = MappingProxyType({
    CODEX + 'codex-x86_64-unknown-linux-musl.tar.gz': 645227929,
    CODEX + 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz': 645227482,
    CODEX + 'codex-aarch64-unknown-linux-musl.tar.gz': 645213549,
    CODEX + 'codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz': 645213791,
})


def download_request(url):
    asset = GITHUB_ASSET_IDS.get(url)
    if asset is None:
        if url.startswith(CODEX):
            raise ValueError('unreviewed GitHub provider asset')
        return url
    return urllib.request.Request(
        'https://api.github.com/repos/openai/codex/releases/assets/' + str(asset),
        headers={'Accept': 'application/octet-stream',
                 'X-GitHub-Api-Version': '2022-11-28'})


def download(url):
    """Retry transient HTTP failures; keep exact asset and digest validation."""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(download_request(url), timeout=120) as response:
                return response.read(256 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                raise
            time.sleep(attempt + 1)


def assets(machine=None):
    machine = platform.machine() if machine is None else machine
    if machine not in ASSETS:
        raise ValueError('unsupported build architecture: Linux x86_64 or aarch64 required')
    return ASSETS[machine]


def extract(raw, name, machine=None):
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        # No extractall: select precisely one ELF, ignore license/package metadata.
        candidates = [m for m in archive.getmembers() if m.isfile()
                      and (Path(m.name).name == name or Path(m.name).name.startswith(name + '-'))]
        binaries = []
        for member in candidates:
            if member.size > 512 * 1024 * 1024:
                raise ValueError('provider artifact exceeds size cap')
            data = archive.extractfile(member).read()
            if data.startswith(b'\x7fELF') and (machine is None or data[18:20] == ELF_MACHINE[machine]):
                binaries.append(data)
        if len(binaries) != 1:
            raise ValueError('exactly one pinned native ELF required')
        return binaries[0]


def main():
    output = Path('/artifacts/providers')
    output.mkdir()
    machine = platform.machine()
    for name, url, algorithm, expected in assets(machine):
        raw = download(url)
        if len(raw) > 256 * 1024 * 1024 or hashlib.new(algorithm, raw).hexdigest() != expected:
            raise ValueError('pinned provider download checksum mismatch')
        path = output / name
        path.write_bytes(extract(raw, name, machine))
        path.chmod(0o555)


if __name__ == '__main__':
    main()
