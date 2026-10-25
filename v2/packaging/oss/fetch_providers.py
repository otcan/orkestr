"""Fetch only the official pinned Linux x86_64 CLI artifacts; never log in."""
import base64
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

ASSETS = (
    ('codex', 'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-x86_64-unknown-linux-musl.tar.gz',
     'sha256', 'beb339e8ecd9ba057a6bb2dc81ad8ca474812edfbf0fc5056ca818797648dde4'),
    ('codex-code-mode-host', 'https://github.com/openai/codex/releases/download/rust-v0.163.0/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
     'sha256', '314263128ba6592e7e807c265deeaf928a692b72dcbfeb5e0b20c9423b703529'),
    ('claude', 'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.295.tgz',
     'sha512', base64.b64decode('nC9RZ6ZArEavyAiFdEtGK6/XPhjfE79tP2tCh+PjmRUxSO/6W3IuXv/rmo8c6u2UzHyvgKodRj1z6UcBGlbnyA==').hex()),
)


def extract(raw, name):
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        # No extractall: select precisely one ELF, ignore license/package metadata.
        candidates = [m for m in archive.getmembers() if m.isfile()
                      and (Path(m.name).name == name or Path(m.name).name.startswith(name + '-'))]
        binaries = []
        for member in candidates:
            if member.size > 512 * 1024 * 1024:
                raise ValueError('provider artifact exceeds size cap')
            data = archive.extractfile(member).read()
            if data.startswith(b'\x7fELF'):
                binaries.append(data)
        if len(binaries) != 1:
            raise ValueError('exactly one pinned native ELF required')
        return binaries[0]


def main():
    output = Path('/artifacts/providers')
    output.mkdir()
    for name, url, algorithm, expected in ASSETS:
        with urllib.request.urlopen(url, timeout=120) as response:
            raw = response.read(256 * 1024 * 1024 + 1)
        if len(raw) > 256 * 1024 * 1024 or hashlib.new(algorithm, raw).hexdigest() != expected:
            raise ValueError('pinned provider download checksum mismatch')
        path = output / name
        path.write_bytes(extract(raw, name))
        path.chmod(0o555)


if __name__ == '__main__':
    main()
