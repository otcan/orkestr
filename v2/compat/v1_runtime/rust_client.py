"""Bounded owner HTTP client. No WhatsApp transport, retries, or auto-accept policy."""
import hashlib
import http.client
from http.cookies import SimpleCookie
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import threading
import time
from urllib.parse import parse_qsl, urlsplit
import uuid

MAX_BODY = 1024 * 1024
LIMITS = dict(duration_ms=900000, attempts=32, bytes=67108864,
              cleanup_ms=30000, cleanup_attempts=4, cleanup_bytes=1048576)
SESSION = "/api/v2/browser/session"
# Matches the server JSON limit for raw-octet attachment bundles.
ATTACHMENT_MAX_JSON = 68 * 1024 * 1024
# Reads reuse a server identity + session check this recent. Every mutation
# (POST) and any read after a transport failure re-verifies first. Idle
# polling of many bindings otherwise costs two extra requests per read.
READ_RECHECK_S = 30
# The server issues sessions with a fixed 12 h lifetime. A 401 is treated as a
# revocation (no silent re-login), so the session is renewed well before it
# would expire instead.
SESSION_RENEW_S = 10 * 60 * 60


class ClientError(RuntimeError):
    def __init__(self, code, status=None):
        self.code, self.status = code, status
        super().__init__(code if status is None else f"{code}:{status}")


def require(value, code):
    if not value:
        raise ClientError(code)


def identity(value):
    try:
        parsed = uuid.UUID(value)
        require(parsed.int and str(parsed) == value, "invalid_identity")
        return value
    except (ValueError, TypeError, AttributeError):
        raise ClientError("invalid_identity") from None


def integer(value, minimum=0):
    return type(value) is int and minimum <= value < 9007199254740992


def decode(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "invalid_json")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs,
                          parse_constant=lambda _: require(False, "invalid_json"))
    except (ValueError, UnicodeError):
        raise ClientError("invalid_json") from None


def credentials(path):
    """Open every component without following links; never return a path in errors."""
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts and path.name != "auth.json",
            "credential_path_refused")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            require(info.st_uid in (0, os.geteuid()) and
                    (not info.st_mode & 0o022 or sticky_root), "credential_parent_refused")
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.geteuid()) and
                    stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and
                    0 < info.st_size <= 8192, "credential_file_refused")
            raw = os.read(fd, 8193)
            require(len(raw) == info.st_size, "credential_file_changed")
        finally:
            os.close(fd)
    except OSError:
        raise ClientError("credential_file_refused") from None
    finally:
        os.close(directory)
    value = decode(raw)
    require(isinstance(value, dict) and isinstance(value.get("username"), str) and
            isinstance(value.get("password"), str), "credential_shape_refused")
    require(0 < len(value["username"].encode()) <= 128 and
            12 <= len(value["password"].encode()) <= 1024, "credential_shape_refused")
    return {"username": value["username"], "password": value["password"]}


class RustSession:
    """One owner login shared by every binding. Never pinned to a conversation."""

    def __init__(self, *, origin, loopback_url, credentials_path, expected_owner,
                 expected_source, timeout_s=5):
        try:
            public, local = urlsplit(origin), urlsplit(loopback_url)
            require(public.scheme in ("http", "https") and public.hostname and
                    public.username is None and public.password is None and
                    public.path in ("", "/") and not public.query and not public.fragment,
                    "origin_refused")
            require(local.scheme == "http" and ipaddress.ip_address(local.hostname).is_loopback and
                    local.port and local.username is None and local.password is None and
                    local.path in ("", "/") and not local.query and not local.fragment,
                    "loopback_refused")
            public.port  # Reject malformed ports before any credential read.
        except (ValueError, TypeError):
            raise ClientError("endpoint_refused") from None
        require(all(value.isascii() and not any(ord(c) < 33 for c in value)
                    for value in (origin, loopback_url)), "endpoint_refused")
        require(type(timeout_s) in (int, float) and 0 < timeout_s <= 20, "timeout_refused")
        require(isinstance(expected_source, str) and re.fullmatch("[0-9a-f]{40}", expected_source),
                "source_refused")
        self.origin, self.authority = origin.rstrip("/"), public.netloc
        self.host, self.port, self.timeout_s = local.hostname, local.port, timeout_s
        self.owner = identity(expected_owner)
        self.source, self.credentials_path = expected_source, credentials_path
        self._cookie = self._csrf = None
        self.features = frozenset()
        self._revoked = False
        self.generation = 0
        self._verified_at = None
        self._logged_in_at = 0.0
        self._lock = threading.RLock()

    def _wire(self, method, path, body=None, allowed=(200,), events=False,
              max_request=32768, timeout_s=None):
        try:
            data = None if body is None else json.dumps(body, allow_nan=False, separators=(",", ":")).encode()
        except (TypeError, ValueError, UnicodeError):
            raise ClientError("request_shape_refused") from None
        require(data is None or len(data) <= max_request, "request_too_large")
        timeout_s = timeout_s or self.timeout_s
        # The login state is read once under the session lock; the exchange
        # itself runs without it (see `_lock` on RustClient), so one binding's
        # event wait never stalls every other binding's requests.
        with self._lock:
            cookie, csrf, revoked = self._cookie, self._csrf, self._revoked
        if not cookie and path not in ("/api/v2/health", SESSION):
            # Another binding's renewal failed or its 401 revoked the session
            # after this binding's login check. Never send it unauthenticated:
            # the server's 401 would then look like a revocation of the
            # current (absent) session and refuse every binding.
            raise ClientError("session_revoked" if revoked else "transport_failed")
        headers ={"Host": self.authority, "Accept": "text/event-stream" if events else "application/json",
                   "Connection": "close"}
        if cookie and path != "/api/v2/health":
            headers["Cookie"] = cookie
        if method == "POST":
            headers.update({"Origin": self.origin, "Content-Type": "application/json"})
            if path != SESSION:
                headers["X-Orkestr-CSRF"] = csrf
        connection = http.client.HTTPConnection(self.host, self.port, timeout=timeout_s)
        started, timer = time.monotonic(), None
        raw = bytearray()
        try:
            connection.connect()
            retained_socket = connection.sock
            def expire():
                try:
                    retained_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            timer = threading.Timer(max(0.001, timeout_s - (time.monotonic() - started)), expire)
            timer.daemon = True
            timer.start()
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            if response.status == 401:
                with self._lock:
                    if self._cookie != cookie:
                        # Sent with a session that another binding has since
                        # renewed: not a revocation of the current one. Auth
                        # is checked before any mutation, so a retry is safe.
                        raise ClientError("transport_failed", 401)
                    self._cookie = self._csrf = None
                    self._revoked = True
                raise ClientError("session_revoked", 401)
            if response.status in (301, 302, 303, 307, 308) or response.status not in allowed:
                raise ClientError("unexpected_status", response.status)
            if response.status == 204:
                return 204, None, response.getheaders()
            expected_type = "text/event-stream" if events else "application/json"
            require(response.getheader("Content-Type", "").split(";")[0].lower() == expected_type and
                    response.getheader("Content-Encoding", "identity") == "identity", "response_type_refused")
            while len(raw) <= MAX_BODY:
                try:
                    chunk = response.read1(min(8192, MAX_BODY + 1 - len(raw)))
                except (OSError, http.client.HTTPException):
                    if events:
                        break
                    raise
                if not chunk:
                    break
                raw.extend(chunk)
                if events and (b"\n\n" in raw or b"\r\n\r\n" in raw):
                    break
            require(len(raw) <= MAX_BODY, "response_too_large")
            if events:
                return response.status, bytes(raw), response.getheaders()
            require(response.length in (None, 0), "response_incomplete")
            return response.status, decode(raw), response.getheaders()
        except ClientError:
            raise
        except (OSError, http.client.HTTPException, ValueError, TypeError):
            # A lost or restarted server is checked again before the next read.
            self._verified_at = None
            raise ClientError("transport_outcome_unknown" if method == "POST" else "transport_failed") from None
        finally:
            connection.close()
            if timer:
                timer.cancel()
                timer.join()

    def _health(self):
        _, value, _ = self._wire("GET", "/api/v2/health")
        require(isinstance(value, dict) and value.get("status") == "ok" and
                value.get("product") == "orkestr-v2" and value.get("fixture_mode") is False and
                isinstance(value.get("build"), dict) and
                value["build"].get("format") == "orkestr-v2-build-identity-v1" and
                value["build"].get("component") == "server" and
                value["build"].get("source_commit") == self.source, "source_mismatch")
        # Optional request fields the server accepts (its request bodies refuse
        # unknown fields, so an unadvertised field is never sent).
        features = value.get("features")
        self.features = frozenset(f for f in features if isinstance(f, str)) if isinstance(features, list) else frozenset()

    def _session(self, value):
        require(isinstance(value, dict) and value.get("owner_id") == self.owner and
                value.get("csrf_token") == self._csrf, "session_scope_mismatch")

    def login(self, mutation=True):
        """Returns the session generation; a new generation needs scope re-verification.

        A read may reuse a verification younger than READ_RECHECK_S; a mutation
        always verifies the server identity and session first."""
        with self._lock:
            require(not self._revoked, "session_revoked")
            if self._cookie and time.monotonic() - self._logged_in_at >= SESSION_RENEW_S:
                # Log in again while the current session is still valid.
                self._cookie = self._csrf = None
                self._verified_at = None
            if (not mutation and self._cookie and self._verified_at is not None and
                    time.monotonic() - self._verified_at < READ_RECHECK_S):
                return self.generation
            self._verified_at = None
            self._health()
            if self._cookie:
                _, value, _ = self._wire("GET", SESSION)
                self._session(value)
                self._verified_at = time.monotonic()
                return self.generation
            _, value, headers = self._wire("POST", SESSION, credentials(self.credentials_path))
            cookies = [v for k, v in headers if k.lower() == "set-cookie"]
            require(len(cookies) == 1, "session_cookie_refused")
            parsed = SimpleCookie()
            try:
                parsed.load(cookies[0])
            except http.cookies.CookieError:
                raise ClientError("session_cookie_refused") from None
            require(set(parsed) == {"orkestr_v2_session"}, "session_cookie_refused")
            cookie = parsed["orkestr_v2_session"]
            require(re.fullmatch("[0-9a-f]{64}", cookie.value) and cookie["path"] == "/api/v2" and
                    cookie["httponly"] and cookie["samesite"].lower() == "strict" and
                    not cookie["domain"] and (not self.origin.startswith("https:") or cookie["secure"]),
                    "session_cookie_refused")
            self._csrf = hashlib.sha256(f"orkestr-v2-browser-csrf-v1:{cookie.value}".encode()).hexdigest()
            try:
                self._session(value)
            except ClientError:
                self._cookie = self._csrf = None
                self._revoked = True
                raise
            self._cookie = f"orkestr_v2_session={cookie.value}"
            self.generation += 1
            self._verified_at = self._logged_in_at = time.monotonic()
            return self.generation


class RustClient:
    """Conversation-pinned view of a shared owner session.

    Requests of one client (one binding) are serialized by the client's own
    lock; clients sharing a session run their requests concurrently. The
    session lock guards only the login state and (rare) login exchanges.
    Before, every request of every binding ran under the session lock, so
    one caught-up event read (up to the 5 s client deadline) froze all
    bindings: the adapter issued requests in ~5 s bursts and an owner
    message waited for several of them before its intake, Fast export and
    acceptance (live: 14 s to intake and 23 s from Fast proposal to export)."""

    def __init__(self, *, conversation_id, session=None, **session_options):
        self.session = session or RustSession(**session_options)
        self.owner, self.conversation = self.session.owner, identity(conversation_id)
        self.prefix = f"/api/v2/conversations/{self.conversation}"
        self._verified = None
        self._scope_refused = False
        self._client_lock = threading.RLock()

    @property
    def features(self):
        """Server features seen at the last identity check (empty before login)."""
        return self.session.features

    # Compatibility views used by diagnostics and tests.
    @property
    def _cookie(self):
        return self.session._cookie

    @property
    def _revoked(self):
        return self.session._revoked or self._scope_refused

    @_revoked.setter
    def _revoked(self, value):
        self.session._revoked = self._scope_refused = bool(value)

    @property
    def _lock(self):
        return self._client_lock

    def _wire(self, *args, **kwargs):
        return self.session._wire(*args, **kwargs)

    def ensure_login(self, mutation=True):
        with self._lock:
            require(not self._scope_refused, "conversation_scope_mismatch")
            generation = self.session.login(mutation)
            if self._verified == generation:
                return
            try:
                _, snapshot, _ = self._wire("GET", self.prefix)
                require(isinstance(snapshot, dict) and snapshot.get("conversation_id") == self.conversation,
                        "conversation_scope_mismatch")
            except ClientError as error:
                # A wrong conversation refuses only this binding, never the shared session.
                if error.code == "conversation_scope_mismatch" or error.status == 404:
                    self._scope_refused = True
                raise
            self._verified = generation

    def _path(self, method, suffix):
        require(isinstance(suffix, str) and suffix.isascii() and
                not any(c in suffix for c in "%#\\") and not any(ord(c) < 33 for c in suffix),
                "route_refused")
        path = urlsplit(suffix)
        require(not path.scheme and not path.netloc, "route_refused")
        read = {"": ("after", "limit"), "/window": (), "/execution": ("run_id",),
                "/fast/execution": ("run_id",), "/accepted-results": ("after_sequence", "limit"),
                "/intelligence": (), "/held-inputs": (), "/window/queue": (), "/events": ("after", "limit"),
                "/timer-inputs": ("after_sequence", "limit"), "/settings": (),
                "/timer-digests": ("limit",), "/posts": ("pending", "limit"),
                "/thread-ask-inputs": ("after_sequence", "limit")}
        payload = path.path.startswith("/payloads/") and identity(path.path[10:])
        digest_ack = (method == "POST" and path.path.startswith("/timer-digests/") and
                      path.path.endswith("/delivered") and identity(path.path[15:-10]))
        post_ack = (method == "POST" and path.path.startswith("/posts/") and
                    path.path.endswith("/delivered") and identity(path.path[7:-10]))
        steering = (method == "GET" and path.path.startswith("/steering/") and
                    re.fullmatch(r"[A-Za-z0-9:._-]{1,128}", path.path[10:]))
        retire = (method == "POST" and path.path.startswith("/inputs/") and path.path.endswith("/retire") and
                  identity(path.path[8:-7]))
        require((method == "GET" and (path.path in read or payload or steering)) or digest_ack or post_ack or retire or
                (method == "POST" and path.path in ("/messages", "/window", "/accept", "/settings/render",
                                                    "/timer-outcomes", "/timer-triggers", "/steer")), "route_refused")
        try:
            query = parse_qsl(path.query, strict_parsing=True, max_num_fields=2)
        except ValueError:
            raise ClientError("query_refused") from None
        require(len(dict(query)) == len(query) and
                all(k in read.get(path.path, ()) for k, _ in query) and
                (method == "GET" or not query), "query_refused")
        for key, value in query:
            if key == "run_id":
                identity(value)
            elif key == "pending":
                require(value == "true", "query_refused")
            else:
                require(value.isdecimal() and integer(int(value), 1 if key == "limit" else 0) and
                        (key != "limit" or int(value) <= 100), "query_refused")
        return self.prefix + suffix

    def request(self, method, suffix, body=None, allowed=(200,)):
        with self._lock:
            path = self._path(method, suffix)
            require((method == "GET" and body is None) or (method == "POST" and isinstance(body, dict)),
                    "request_shape_refused")
            require(urlsplit(suffix).path != "/events", "use_read_events")
            self.ensure_login(mutation=method != "GET")
            status, value, _ = self._wire(method, path, body, allowed)
            if isinstance(value, dict):
                require(value.get("conversation_id", self.conversation) == self.conversation and
                        value.get("owner_id", self.owner) == self.owner, "response_scope_mismatch")
            return status, value

    def import_attachments(self, request):
        """Copy staged V1 bytes into this conversation's attachment store (idempotent by request_key)."""
        require(isinstance(request, dict) and set(request) == {"request_key", "source", "target_manifest", "mapping"},
                "request_shape_refused")
        target = request["target_manifest"]
        require(isinstance(target, dict) and target.get("owner_id") == self.owner and
                target.get("conversation_id") == self.conversation, "attachment_scope_refused")
        with self._lock:
            self.ensure_login()
            _, value, _ = self._wire("POST", self.prefix + "/attachment-imports", request, (200,),
                                     max_request=ATTACHMENT_MAX_JSON, timeout_s=60)
        require(isinstance(value, dict) and value.get("manifest") == target and
                value.get("mapping") == request["mapping"] and
                value.get("source_manifest_id") == request["source"]["manifest"]["manifest_id"],
                "attachment_receipt_mismatch")
        identity(value.get("import_id"))
        return value

    def read_events(self, after, maximum=100, timeout_s=None):
        require(integer(after) and type(maximum) is int and 1 <= maximum <= 100, "cursor_refused")
        require(timeout_s is None or (type(timeout_s) in (int, float) and 0 < timeout_s <= 20),
                "event_deadline_refused")
        with self._lock:
            self.ensure_login(mutation=False)
            _, raw, _ = self._wire("GET", f"{self.prefix}/events?after={after}&limit={maximum}",
                                   events=True, timeout_s=None if timeout_s is None else min(timeout_s, self.session.timeout_s))
        events, cursor = [], after
        for frame in raw.replace(b"\r\n", b"\n").split(b"\n\n")[:-1]:
            fields = {}
            for line in frame.split(b"\n"):
                if line.startswith(b":") or not line:
                    continue
                key, separator, value = line.partition(b":")
                require(separator and key not in fields, "event_frame_refused")
                fields[key] = value.removeprefix(b" ")
            if not fields:
                continue
            require(fields.get(b"event") not in (b"session_expired", b"resync_required"), "events_resync_required")
            value = decode(fields.get(b"data", b""))
            require(isinstance(value, dict) and integer(value.get("sequence"), cursor + 1) and
                    fields.get(b"id") == str(value["sequence"]).encode() and
                    value.get("owner_id") == self.owner and value.get("aggregate_id") == self.conversation,
                    "event_scope_mismatch")
            cursor = value["sequence"]
            events.append(value)
            if len(events) == maximum:
                break
        return events

    def window_request(self, intake, input_request_key, request_key, current_window):
        require(isinstance(intake, dict) and intake.get("status") == "accepted" and
                integer(intake.get("sequence"), 1), "intake_refused")
        identity(intake.get("message_id"))
        identity(intake.get("event_id"))
        require(all(isinstance(k, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", k)
                    for k in (input_request_key, request_key)), "request_key_refused")
        current = current_window
        if current is not None:
            require(isinstance(current, dict) and current.get("conversation_id") == self.conversation and
                    current.get("state") in ("active", "closed") and integer(current.get("generation"), 1) and
                    current.get("limits") == LIMITS and integer(current.get("opened_at_ms")) and
                    integer(current.get("work_deadline_ms")) and
                    870000 <= current["work_deadline_ms"] - current["opened_at_ms"] <= 14370000 and
                    current.get("expires_at_ms") == current["work_deadline_ms"] + 30000, "window_refused")
            identity(current.get("window_id"))
        return dict(request_key=request_key, input_message_id=intake["message_id"],
                    input_event_id=intake["event_id"], input_request_key=input_request_key,
                    expected_generation=0 if current is None else current["generation"],
                    window_id=current["window_id"] if current and current["state"] == "active" else None,
                    predecessor_window_id=current["window_id"] if current and current["state"] == "closed" else None)

    def matching_run_ids(self, events, intake):
        """Evidence only: caller must still select the exact Deep/Fast role endpoint."""
        message, event = identity(intake.get("message_id")), identity(intake.get("event_id"))
        runs = set()
        require(isinstance(events, list) and len(events) <= 100, "event_bound_refused")
        for value in events:
            require(value.get("owner_id") == self.owner and value.get("aggregate_id") == self.conversation,
                    "event_scope_mismatch")
            if value.get("source_message_id") != message or value.get("source_event_id") != event:
                continue
            payload = value.get("payload_ref_or_safe_payload", {})
            if payload.get("kind") == "provider_observed" and value.get("schema_version") in (5, 8):
                runs.add(identity(payload.get("run_id")))
        return sorted(runs)
