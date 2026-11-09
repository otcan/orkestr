"""Pinned service-only transport for operator consumers. No password fallback.

Install this bootstrap as an immutable trusted executable/module. It verifies
the complete imported runtime before loading it. Callers supply their own closed
route set; this module never retries a business request or sends a fallback.
"""
import hashlib
import importlib.util
import importlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading

FIELDS = {'runtime_directory', 'runtime_files', 'cache_path', 'credentials_path',
          'origin', 'loopback_url', 'expected_owner', 'expected_source', 'peer_descriptor_path'}
RUNTIME_FILES = {'__init__.py', 'rust_client.py', 'service_session_cache.py', 'service_peer.py'}
IMPORT_LOCK = threading.RLock()


class ServiceError(RuntimeError):
    def __init__(self, code, status=None, outcome='refused'):
        self.code, self.status, self.outcome = code, status, outcome
        super().__init__(code)


def require(value, code):
    if not value: raise ServiceError(code)


def protected(path, mode=None):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'service_path_refused')
    for item in (path, *path.parents):
        meta = item.lstat()
        sticky = item != path and meta.st_uid == 0 and meta.st_mode & stat.S_ISVTX
        require(not stat.S_ISLNK(meta.st_mode) and meta.st_uid in (0, os.geteuid())
                and (not meta.st_mode & 0o022 or sticky), 'service_custody_refused')
    meta = path.lstat()
    require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1
            and (mode is None or stat.S_IMODE(meta.st_mode) == mode), 'service_custody_refused')
    return path


def read_config(path):
    path = protected(path, 0o600)
    require(path.stat().st_size <= 16384, 'service_config_size_refused')
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'service_config_shape_refused'); value[key] = item
        return value
    value = json.loads(path.read_text(), object_pairs_hook=pairs)
    require(type(value) is dict and set(value) == FIELDS, 'service_config_shape_refused')
    require(type(value['runtime_directory']) is str and type(value['runtime_files']) is dict
            and set(value['runtime_files']) == RUNTIME_FILES, 'service_runtime_shape_refused')
    return value


def runtime(config):
    directory = Path(config['runtime_directory'])
    for name, expected in config['runtime_files'].items():
        source = protected(directory / name)
        require(source.stat().st_size <= 1024 * 1024, 'service_runtime_size_refused')
        require(type(expected) is str and re.fullmatch('[0-9a-f]{64}', expected)
                and hashlib.sha256(source.read_bytes()).hexdigest() == expected, 'service_runtime_pin_refused')
    fingerprint = hashlib.sha256((str(directory) + json.dumps(config['runtime_files'], sort_keys=True)).encode()).hexdigest()[:20]
    package_name = 'orkestr_service_runtime_' + fingerprint
    with IMPORT_LOCK:
        for name in list(sys.modules):
            if name == package_name or name.startswith(package_name + '.'): sys.modules.pop(name, None)
        spec = importlib.util.spec_from_file_location(package_name, directory / '__init__.py',
                                                      submodule_search_locations=[str(directory)])
        package = importlib.util.module_from_spec(spec); sys.modules[package_name] = package
        spec.loader.exec_module(package)
        client = importlib.import_module(package_name + '.rust_client')
        cache = importlib.import_module(package_name + '.service_session_cache')
    require(set(client.credentials(config['credentials_path'])) == {'service_token'}, 'service_credentials_required')
    return client, cache


class ServiceClient:
    def __init__(self, config_path, *, routes):
        try:
            self.config = read_config(config_path)
            self.client, self.cache = runtime(self.config)
        except ServiceError:
            raise
        except (OSError, ValueError, TypeError):
            raise ServiceError('service_configuration_refused') from None
        self.options = {key: value for key, value in self.config.items()
                        if key not in {'runtime_directory', 'runtime_files', 'cache_path'}}
        # Constructor validates endpoint, canonical owner and source pins before
        # any cache or network operation, even for an empty route set.
        self.client.RustSession(**self.options)
        require(type(routes) in (tuple, list) and routes, 'service_routes_required')
        self.routes = [(method, re.compile(pattern)) for method, pattern in routes]

    def request(self, method, path, body=None, *, allowed=(200,), max_request=32768,
                timeout_s=None):
        """One request; an explicit bounded operation deadline never changes defaults.

        Some configured operations complete external setup before responding.
        A longer deadline avoids abandoning those single requests; it never
        retries them or changes source, peer, session or route validation.
        """
        require(type(path) is str and len(path) <= 4096 and not any(ord(c) < 32 for c in path)
                and any(method == verb and pattern.fullmatch(path) for verb, pattern in self.routes), 'service_route_refused')
        require(timeout_s is None or (type(timeout_s) in (int, float) and 0 < timeout_s <= 120),
                'service_deadline_refused')
        mutation = method in ('POST', 'PUT', 'PATCH', 'DELETE')
        attempted = False
        try:
            with self.cache.ServiceSessionCache(self.config['cache_path'], **self.options) as session:
                scope = re.match(r'/api/v2/conversations/([0-9a-f-]{36})(?:/|$|\?)', path)
                if scope:
                    self.client.RustClient(conversation_id=scope[1], session=session).ensure_login(mutation=mutation)
                else:
                    session.login(mutation=mutation)
                attempted = True
                status, value, _ = session._wire(method, path, body, allowed=allowed,
                                               max_request=max_request, timeout_s=timeout_s)
                return status, value
        except self.client.ClientError as failure:
            ambiguous = (mutation and attempted and getattr(failure, "outcome", None) != "refused" and (failure.status is None or failure.status == 408
                         or failure.status >= 500 or 200 <= failure.status < 400))
            raise ServiceError('mutation_outcome_unknown' if ambiguous else 'service_request_refused',
                               failure.status, 'unknown' if ambiguous else 'refused') from None
        except (OSError, ValueError, TypeError):
            raise ServiceError('mutation_outcome_unknown' if mutation and attempted else 'service_request_refused',
                               outcome='unknown' if mutation and attempted else 'refused') from None
