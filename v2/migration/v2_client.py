"""Minimal owner API client (browser-session flow) using the standard library only.

Credentials come from an explicit private JSON file; the session cookie and
CSRF token stay in memory and are revoked on close. Nothing is logged.
"""
import json
import os
from pathlib import Path
import stat
from urllib import error, parse, request


class ApiError(RuntimeError):
    def __init__(self, status, code):
        super().__init__(f'{status}:{code}')
        self.status = status
        self.code = code


def read_credentials(path):
    path = Path(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ApiError(0, 'credentials_file_must_be_private')
    value = json.loads(path.read_text())
    if set(value) != {'username', 'password'}:
        raise ApiError(0, 'credentials_file_fields')
    return value['username'], value['password']


class Client:
    def __init__(self, base_url, origin=None, timeout=60):
        parsed = parse.urlsplit(base_url)
        if parsed.scheme not in {'http', 'https'} or not parsed.netloc or parsed.path not in {'', '/'}:
            raise ApiError(0, 'invalid_base_url')
        self.base = f'{parsed.scheme}://{parsed.netloc}'
        self.origin = origin or self.base
        self.timeout = timeout
        self.cookie = None
        self.csrf = None
        self.opener = request.build_opener(request.HTTPHandler, request.HTTPSHandler)

    def _send(self, method, path, body=None, auth=True):
        headers = {'Accept': 'application/json', 'Origin': self.origin}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if auth:
            headers['Cookie'] = f'orkestr_v2_session={self.cookie}'
            if method not in {'GET', 'HEAD'}:
                headers['X-Orkestr-Csrf'] = self.csrf
        req = request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                raw, status, cookies = response.read(), response.status, response.headers.get_all('Set-Cookie') or []
        except error.HTTPError as failure:
            try:
                code = str(json.loads(failure.read()).get('code') or 'http_error')[:64]
            except (ValueError, AttributeError):
                code = 'http_error'
            raise ApiError(failure.code, code) from None
        except error.URLError:
            raise ApiError(0, 'unreachable') from None
        return status, (json.loads(raw) if raw else None), cookies

    def login(self, username, password):
        _, body, cookies = self._send('POST', '/api/v2/browser/session',
                                      {'username': username, 'password': password}, auth=False)
        for cookie in cookies:
            name, _, rest = cookie.partition('=')
            if name.strip() == 'orkestr_v2_session':
                self.cookie = rest.split(';', 1)[0]
        if not self.cookie or not isinstance(body, dict) or not body.get('csrf_token'):
            raise ApiError(0, 'login_failed')
        self.csrf = body['csrf_token']
        return body

    def close(self):
        if self.cookie:
            try:
                self._send('DELETE', '/api/v2/browser/session')
            except ApiError:
                pass
            self.cookie = self.csrf = None

    def get(self, path, query=None):
        if query:
            path += '?' + parse.urlencode({k: v for k, v in query.items() if v is not None})
        return self._send('GET', path)[1]

    def post(self, path, body):
        return self._send('POST', path, body)[1]

    def put(self, path, body):
        """Returns (status, body) so callers can tell created from replayed."""
        status, value, _ = self._send('PUT', path, body)
        return status, value
