#!/usr/bin/python3
"""Fixed opt-in offline Worker broker; private installer selects this executable."""
from pathlib import Path
from server import main


def worker_main():
    # No CLI/env configuration path and no browser-selected profile. Installer
    # provisions this sibling private file and immutable package independently.
    return main(Path(__file__).with_name('worker-broker-private.json'),offline_python=True)


if __name__=='__main__':
    raise SystemExit(worker_main())
