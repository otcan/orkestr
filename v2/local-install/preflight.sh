#!/bin/sh
# Uses an already-built binary; never downloads dependencies or invokes Cargo.
set -eu
command -v python3 >/dev/null 2>&1 || { echo 'Python 3.11+ is required' >&2; exit 1; }
exec python3 "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/helper.py" preflight "$@"
