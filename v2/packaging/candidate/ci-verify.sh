#!/bin/sh
# Read-only candidate integrity check and lightweight synthetic regression suite.
set -eu
candidate=${1:?Usage: ci-verify.sh absolute-candidate-directory}
case "$candidate" in /*) ;; *) echo 'absolute candidate directory required' >&2; exit 2;; esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 -B "$script_dir/package_candidate.py" verify "$candidate"
python3 -B -m unittest discover -s "$script_dir/tests" -v
python3 -B -m unittest discover -s "$script_dir/../docker/tests" -v
