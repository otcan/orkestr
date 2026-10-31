"""Opt-in first-owner creation for a loopback-published Docker install.

The operator enables this with ORKESTR_OSS_LOCAL_SETUP=1 and publishes only
127.0.0.1:19822:19823. Docker's proxy obscures the original peer, so Host is
not proof of locality: the explicit deployment opt-in is the trust boundary.
The bootstrap credential stays server-side. The ordinary server remains the
authority for rate limits, password validation and atomic first-owner creation.
"""
import json
import urllib.error

AUTHORITY = '127.0.0.1:19822'
ORIGIN = 'http://' + AUTHORITY


def account(handler, method, bootstrap, server):
    if not bootstrap:
        return handler.reply(404, {'message': 'Local account setup is disabled.'})
    headers = handler.headers
    # The custom header forces cross-origin browsers to preflight; the proxy
    # serves no CORS permission. Exact Host also rejects DNS rebinding.
    if (headers.get('Host') != AUTHORITY
            or headers.get('x-orkestr-local-setup') != '1'
            or headers.get('Sec-Fetch-Site') not in (None, 'same-origin')
            or headers.get('Origin') not in (None, ORIGIN)
            or headers.get('Authorization')):
        return handler.reply(403, {'message': 'Open Orkestr on this computer to create your account.'})
    body = None
    if method == 'POST':
        if headers.get('Origin') != ORIGIN:
            return handler.reply(403, {'message': 'Account setup requires the local browser page.'})
        length = headers.get('Content-Length', '')
        if not length.isdigit() or int(length) > 4096:
            return handler.reply(413, {'message': 'Account details are too large.'})
        if headers.get('Content-Type') != 'application/json':
            return handler.reply(400, {'message': 'Account details must be JSON.'})
        try:
            body = json.loads(handler.rfile.read(int(length)))
        except (ValueError, UnicodeError):
            return handler.reply(400, {'message': 'Account details must be JSON.'})
        if (not isinstance(body, dict) or set(body) != {'username', 'password'}
                or not all(isinstance(value, str) for value in body.values())):
            return handler.reply(400, {'message': 'A username and password are required.'})
    try:
        value = server(method, '/api/v2/setup', body,
                       {'Host': AUTHORITY, 'Origin': ORIGIN, 'x-orkestr-bootstrap': bootstrap})
    except urllib.error.HTTPError as error:
        messages = {400: 'Choose a username and a password of at least 12 characters.',
                    409: 'An account already exists. Sign in instead.',
                    429: 'Too many attempts. Wait a minute and try again.'}
        return handler.reply(error.code if error.code in messages else 503,
                             {'message': messages.get(error.code, 'Account setup is unavailable. Try again.')})
    except (OSError, ValueError, urllib.error.URLError):
        return handler.reply(503, {'message': 'Account setup is unavailable. Try again.'})
    if method == 'GET':
        return handler.reply(200, {'setup_required': value.get('setup_required') is True})
    return handler.reply(201, {'created': True})
