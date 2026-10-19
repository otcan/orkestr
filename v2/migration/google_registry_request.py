"""Isolated browser request bridge; shared server registration is not installed.

Canonical session authority must implement authenticate_browser using current
Store.authenticate(browser-prefixed credential), without caching its result.
"""
from dataclasses import dataclass, field
import json
from types import MappingProxyType
from typing import Protocol

from .google_registry_metadata import (
    CurrentAccount, RegistryDescriptor, RegistryRefused, read_registry_metadata,
)

ROUTE = '/api/v2/connectors/google/registry-metadata'


class BrowserSessionAuthority(Protocol):
    def authenticate_browser(self, credential: str) -> str | None:
        """Current ordinary Store session lookup, never registry-derived identity."""


class RequestRefused(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    query: str = ''
    content_length: str = ''
    headers: tuple[tuple[str, str], ...] = field(default=(), repr=False)

    def values(self, name):
        return [value for key, value in self.headers if key.lower() == name]


@dataclass(frozen=True)
class RequestVerifier:
    authority: BrowserSessionAuthority = field(repr=False)
    credential: str = field(repr=False)

    def __call__(self):
        try:
            owner = self.authority.authenticate_browser(self.credential)
        except Exception:
            raise RequestRefused(503, 'authority_unavailable') from None
        if type(owner) is not str or not owner:
            raise RequestRefused(401, 'authentication_required')
        return CurrentAccount(owner)


def bind_verifier(request, authority, host, origin):
    """Freeze one cookie request, not its session authorization outcome."""
    if (len(request.headers) > 128
            or any(type(key) is not str or type(value) is not str
                   or len(key) + len(value) > 16384 for key, value in request.headers)
            or sum(len(key) + len(value) for key, value in request.headers) > 32768):
        raise RequestRefused(400, 'request_parameters_rejected')
    if request.values('authorization'):
        raise RequestRefused(401, 'authentication_required')
    if request.values('host') != [host]:
        raise RequestRefused(403, 'host_rejected')
    origins = request.values('origin')
    if origins and origins != [origin]:
        raise RequestRefused(403, 'origin_rejected')
    tokens = []
    for cookie in request.values('cookie'):
        for part in cookie.split(';'):
            name, sep, value = part.strip().partition('=')
            if sep and name == 'orkestr_v2_session':
                tokens.append(value)
    if (len(tokens) != 1 or len(tokens[0]) != 64
            or any(char not in '0123456789abcdefABCDEF' for char in tokens[0])):
        raise RequestRefused(401, 'authentication_required')
    return RequestVerifier(authority, 'browser:' + tokens[0])


class ExactOwnerRegistries:
    """Trusted construction only: never build this map from request/registry JSON."""
    def __init__(self, descriptors):
        copied = dict(descriptors)
        for owner, descriptor in copied.items():
            if (type(owner) is not str or not owner
                    or not isinstance(descriptor, RegistryDescriptor)
                    or descriptor.owner != owner):
                raise ValueError('exact owner descriptor required')
        self._descriptors = MappingProxyType(copied)

    def resolve(self, account):
        # No admin/global/default fallback, even if another descriptor exists.
        descriptor = self._descriptors.get(account.user_id)
        if descriptor is None:
            raise RequestRefused(503, 'registry_unavailable')
        return descriptor


class RegistryMetadataBridge:
    def __init__(self, authority, registries, *, host, origin):
        self.authority = authority
        self.registries = registries
        self.host, self.origin = host, origin

    def handle(self, request):
        """Fixed status/error DTO; never includes paths, owners or exception text."""
        try:
            if request.path != ROUTE:
                raise RequestRefused(404, 'not_found')
            if request.method != 'GET':
                raise RequestRefused(405, 'method_not_allowed')
            if (request.query or request.content_length not in ('', '0')
                    or request.values('transfer-encoding')
                    or any(request.values(name) for name in
                           ('x-owner-id', 'x-account-id', 'x-user-id', 'x-registry-path'))):
                raise RequestRefused(400, 'request_parameters_rejected')
            verifier = bind_verifier(request, self.authority, self.host, self.origin)
            account = verifier()
            descriptor = self.registries.resolve(account)
            def current_exact_owner():
                current = verifier()
                if current.user_id != account.user_id:
                    raise RequestRefused(403, 'owner_scope_changed')
                return current
            # The leaf rechecks current auth before open AND before delivery.
            metadata = read_registry_metadata(descriptor, current_exact_owner)
            return 200, {'format_version': 1, 'status': 'configuration_observed',
                         'metadata': metadata}
        except RequestRefused as error:
            return error.status, {'format_version': 1, 'status': 'refused', 'error': error.code}
        except RegistryRefused:
            return 503, {'format_version': 1, 'status': 'refused', 'error': 'registry_unavailable'}

    def __call__(self, environ, start_response):
        """WSGI mount for isolated tests/embedding; no socket or lifecycle ownership."""
        headers = tuple((key[5:].replace('_', '-').lower(), value)
                        for key, value in environ.items() if key.startswith('HTTP_'))
        request = Request(environ.get('REQUEST_METHOD', ''), environ.get('PATH_INFO', ''),
                          environ.get('QUERY_STRING', ''), environ.get('CONTENT_LENGTH', ''), headers)
        status, value = self.handle(request)
        body = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
        labels = {200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
                  404: 'Not Found', 405: 'Method Not Allowed', 503: 'Service Unavailable'}
        response_headers = [('Content-Type', 'application/json'), ('Cache-Control', 'no-store'),
                            ('X-Content-Type-Options', 'nosniff'), ('Content-Length', str(len(body)))]
        if status == 405:
            response_headers.append(('Allow', 'GET'))
        start_response(f'{status} {labels[status]}', response_headers)
        return [body]
