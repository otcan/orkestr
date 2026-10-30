"""Fetch only the official pinned Linux x86_64/aarch64 CLI artifacts; never log in."""
import base64
import hashlib
import io
from pathlib import Path
import platform
import tarfile
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
        with urllib.request.urlopen(url, timeout=120) as response:
            raw = response.read(256 * 1024 * 1024 + 1)
        if len(raw) > 256 * 1024 * 1024 or hashlib.new(algorithm, raw).hexdigest() != expected:
            raise ValueError('pinned provider download checksum mismatch')
        path = output / name
        path.write_bytes(extract(raw, name, machine))
        path.chmod(0o555)


if __name__ == '__main__':
    main()
