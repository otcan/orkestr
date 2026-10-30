"""Exact GHCR tags for one V2 beta image publish; refuses everything else.

The repository's V1 image (root ci.yml) owns :latest, :main, :sha-* and the
v0.* release tags in the same GHCR package. A V2 publish may only write
v2.0.0-beta.N (the release) or v2.0.0-beta.N-rc.M (a pre-release candidate),
plus their -amd64/-arm64 per-architecture tags. Never :latest.
"""
import json
import re
import sys

IMAGE = 'ghcr.io/otcan/orkestr'
ARCHES = ('amd64', 'arm64')
RELEASE = re.compile(r'v2\.0\.0-beta\.(0|[1-9][0-9]*)')
CANDIDATE = re.compile(r'v2\.0\.0-beta\.(0|[1-9][0-9]*)-rc\.([1-9][0-9]*)')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def tags(ref_name, cargo_version):
    """Return {'image', 'tag', 'arch_tags', 'candidate'} for an allowed ref."""
    require(isinstance(ref_name, str) and isinstance(cargo_version, str), 'string inputs required')
    release = RELEASE.fullmatch(ref_name)
    candidate = CANDIDATE.fullmatch(ref_name)
    require(release or candidate, 'only v2.0.0-beta.N or v2.0.0-beta.N-rc.M tags publish a V2 image')
    if release:
        # A release tag must name exactly the version the image reports.
        require(ref_name == 'v' + cargo_version, 'release tag must equal v + v2/Cargo.toml version')
    else:
        require(re.fullmatch(r'2\.0\.0-beta\.[0-9]+', cargo_version), 'beta workspace version required')
    arch_tags = {arch: f'{ref_name}-{arch}' for arch in ARCHES}
    for tag in (ref_name, *arch_tags.values()):
        assert_v2_tag(tag)
    return {'image': IMAGE, 'tag': ref_name, 'arch_tags': arch_tags, 'candidate': bool(candidate)}


def assert_v2_tag(tag):
    """Last-line check before any push: never a V1 or floating tag."""
    require(tag not in ('latest', 'main', 'stable', 'edge'), 'floating tag refused')
    require(tag.startswith('v2.0.0-beta.'), 'V2 beta tag prefix required')
    require(re.fullmatch(r'v2\.0\.0-beta\.[0-9]+(-rc\.[0-9]+)?(-(amd64|arm64))?', tag), 'unexpected V2 tag shape')
    return tag


def main(argv):
    if len(argv) == 3 and argv[0] == 'check':
        # check <tag> <expected-tag-list-json>: re-verify a tag right before a push.
        assert_v2_tag(argv[1])
        require(argv[1] in json.loads(argv[2]), 'tag outside the computed publish set')
        return 0
    require(len(argv) == 2, 'usage: publish_tags.py <git-ref-name> <cargo-version>')
    print(json.dumps(tags(argv[0], argv[1]), sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except ValueError as error:
        print('publish refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
