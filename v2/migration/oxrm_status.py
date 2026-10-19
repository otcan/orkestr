"""Content-free canonical MCP health adapter; no operational oXRM tools or mirrors."""
from dataclasses import dataclass
import http.client
import json
import ssl
from types import MappingProxyType
from urllib.parse import urlsplit

MAX_BYTES = 16_384


class Refused(Exception):
    """Fixed public refusal code; never include endpoint or response content."""


@dataclass(frozen=True)
class Binding:
    owner: str
    workspace: str
    account: str
    endpoint_id: str
    mcp_endpoint: str

    def __post_init__(self):
        for value in (self.owner, self.workspace, self.account, self.endpoint_id):
            if (not isinstance(value, str) or not value or len(value.encode()) > 256
                    or value.strip() != value or any(ord(c) < 33 or ord(c) == 127 for c in value)):
                raise ValueError('explicit_exact_binding_required')
        _origin(self.mcp_endpoint)


def _origin(endpoint):
    try:
        u = urlsplit(endpoint)
        if (u.scheme not in ('http', 'https') or not u.hostname or u.username is not None
                or u.password is not None or u.path != '/mcp' or u.query or u.fragment
                or any(ord(c) < 33 or ord(c) == 127 for c in endpoint)):
            raise ValueError()
        port = u.port or (443 if u.scheme == 'https' else 80)
        return u.scheme, u.hostname, port
    except (ValueError, TypeError, AttributeError):
        raise ValueError('exact_mcp_endpoint_required') from None


def read_health(endpoint):
    """No redirects, cookies, authorization, proxy env, initialization or provider calls.

    This function is not invoked by construction. Production invocation requires an
    approved trusted endpoint mapping and separate operational authorization.
    """
    scheme, host, port = _origin(endpoint)
    connection = (http.client.HTTPSConnection(host, port, timeout=2,
                  context=ssl.create_default_context()) if scheme == 'https'
                  else http.client.HTTPConnection(host, port, timeout=2))
    try:
        connection.request('GET', '/health', headers={'Accept': 'application/json'})
        response = connection.getresponse()
        # Redirects never become a second request or carry authority elsewhere.
        if response.status != 200:
            return response.status, b''
        length = response.getheader('Content-Length')
        if length is not None and (not length.isascii() or not length.isdecimal()
                                   or int(length) > MAX_BYTES):
            raise Refused('response_invalid')
        if response.getheader('Content-Encoding', 'identity') != 'identity':
            raise Refused('response_invalid')
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES or (length is not None and len(body) != int(length)):
            raise Refused('response_invalid')
        return 200, body
    finally:
        connection.close()


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_key')
        result[key] = value
    return result


def project(status, body):
    if status in (401, 403):
        raise Refused('upstream_access_denied')
    if status == 404:
        raise Refused('status_transport_unsupported')
    if status != 200:
        raise Refused('upstream_unavailable')
    try:
        if not isinstance(body, bytes) or len(body) > MAX_BYTES:
            raise ValueError()
        raw = json.loads(body, object_pairs_hook=_unique,
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if (not isinstance(raw, dict) or raw.get('status') != 'ok'
                or raw.get('service') != 'oxrm-mcp'
                or not isinstance(raw.get('product'), dict)
                or raw['product'].get('slug') != 'oxrm'
                or not isinstance(raw['product'].get('version'), str)
                or not raw['product']['version']
                or not isinstance(raw.get('deployment'), dict)):
            raise ValueError()
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise Refused('response_invalid') from None
    # Never forward version, deployment strings, IDs or unknown upstream fields.
    # Even an unreviewed server-supplied scope field is NOT an attestation.
    return {'format_version': 1, 'status': 'transport_observed',
            'transport': 'canonical_mcp_health', 'health': 'ok',
            'binding': 'explicit_owner_workspace_account',
            'scope_coverage': 'not_exposed_by_reviewed_transport',
            'capability_coverage': 'not_exposed_by_reviewed_transport',
            'activity_proven': False, 'workflow_ready': False}


class StatusAdapter:
    """Original request authority is verified around one fixed, trusted binding.

    verifier() must recheck the original ordinary account/session, returning its
    exact owner or None. Registry fields and client parameters are never authority.
    Pre/post checks do not make delivery atomic with revocation.
    """
    def __init__(self, bindings, *, transport=read_health):
        values = {}
        endpoints = set()
        pairs = set()
        for binding in bindings:
            if not isinstance(binding, Binding):
                raise ValueError('explicit_exact_binding_required')
            origin = _origin(binding.mcp_endpoint)
            pair = (binding.workspace, binding.account)
            if binding.owner in values or origin in endpoints or pair in pairs:
                raise ValueError('ambiguous_binding')
            values[binding.owner] = binding
            endpoints.add(origin)
            pairs.add(pair)
        self._bindings = MappingProxyType(values)
        self._transport = transport

    def observe(self, verifier):
        def current(expected=None):
            try:
                owner = verifier()
            except Exception:
                raise Refused('authority_unavailable') from None
            if not isinstance(owner, str) or not owner:
                raise Refused('authentication_required')
            if expected is not None and owner != expected:
                raise Refused('owner_scope_changed')
            return owner
        owner = current()
        binding = self._bindings.get(owner)
        if binding is None:
            raise Refused('binding_unavailable')
        current(owner)
        try:
            status, body = self._transport(binding.mcp_endpoint)
        except Refused:
            raise
        except Exception:
            raise Refused('upstream_unavailable') from None
        current(owner)
        return project(status, body)
