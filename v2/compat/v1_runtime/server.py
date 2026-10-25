"""Loopback-only V1 compatibility surface for many bindings. This process never sends WhatsApp."""
import argparse
import base64
import binascii
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import signal
import threading
from urllib.parse import parse_qs, urlsplit

from . import instructions, local_inputs, participants, provisioning
from .config import load
from .ledger import MAX_ATTACHMENT_BYTES, OUTCOMES, Conflict
from .registry import Registry
from .rust_client import RustClient, RustSession

MAX_INPUT_BYTES = 65536
MAX_UPLOAD_BYTES = 4 * (MAX_ATTACHMENT_BYTES // 3 + 1) + 4096
MEDIA_TOKEN = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# Advertised so V1 forwards local input only to an adapter that accepts it.
INPUT_KINDS = ["whatsapp_inbound", local_inputs.KIND]


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, config, registry):
        super().__init__(("127.0.0.1", config["listen_port"]), Handler)
        self.config, self.registry = config, registry
        self.change_waiters = threading.BoundedSemaphore(16)


def valid_filename(name):
    return (isinstance(name, str) and 0 < len(name.encode()) <= 255 and name not in (".", "..") and
            not any(c in "/\\:" or ord(c) < 32 or ord(c) == 127 for c in name))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def answer(self, status, value):
        data = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        values = self.headers.get_all("Authorization", [])
        expected = "Bearer " + self.server.config["token"]
        if len(values) != 1 or not hmac.compare_digest(values[0].encode(), expected.encode()):
            self.answer(401, {"ok": False, "error": "unauthorized"})
            return False
        if self.headers.get("Transfer-Encoding") or self.headers.get("Origin"):
            self.answer(400, {"ok": False, "error": "invalid_transport"})
            return False
        return True

    def route(self, path):
        """(binding, action) for /threads/<remote>/<action>; unknown routes reveal nothing."""
        parts = path.split("/")
        if len(parts) != 4 or parts[0] or parts[1] != "threads":
            return None, None
        binding = self.server.registry.get(parts[2])
        return (binding, parts[3]) if binding else (None, None)

    def json_body(self, maximum):
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not 1 <= int(lengths[0]) <= maximum or self.headers.get_content_type() != "application/json":
            raise ValueError()
        raw = self.rfile.read(int(lengths[0]))
        if len(raw) != int(lengths[0]):
            raise ValueError()
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
        return body

    def do_GET(self):
        if not self.authorized():
            return
        target = urlsplit(self.path)
        if target.path == "/health" and not target.query:
            return self.answer(200, dict(ok=True, inputKinds=INPUT_KINDS, messageChanges={"version": 1, "path": "changes"},
                                         **self.server.registry.status()))
        if target.path == "/changes":
            return self.changes(target.query)
        binding, action = self.route(target.path)
        if binding is None or action not in ("messages", "health", "activity"):
            return self.answer(404, {"ok": False, "error": "route_not_found"})
        if action == "health" and not target.query:
            members = sum(entry["role"] == participants.MEMBER for entry in binding.config["participants"])
            return self.answer(200, dict(ok=True, state=binding.state, error=binding.error, inputKinds=INPUT_KINDS,
                                         enabled=binding.state == "enabled", members=members,
                                         instructionsError=getattr(binding.worker, "instructions_error", None),
                                         **binding.ledger.health()))
        if binding.state in ("revoked", "refused"):
            return self.answer(410 if binding.state == "revoked" else 503,
                               {"ok": False, "error": binding.error or "binding_revoked"})
        if action == "activity":
            from .input_activity import read
            try:
                query=parse_qs(target.query,strict_parsing=True,keep_blank_values=True)
                if set(query)!={"publicMessageId"} or len(query["publicMessageId"])!=1:
                    raise ValueError()
                public_id=query["publicMessageId"][0]
                if not 1<=len(public_id)<=256:raise ValueError()
            except ValueError:
                return self.answer(400,{"ok":False,"error":"invalid_activity_query"})
            value=read(binding.ledger,public_id,enabled=binding.state=="enabled")
            if value is None:return self.answer(404,{"ok":False,"error":"input_not_found"})
            return self.answer(200,dict(ok=True,version=1,publicThreadId=binding.config["public_thread_id"],**value))
        try:
            query = parse_qs(target.query, strict_parsing=True) if target.query else {}
            if set(query) - {"limit"} or len(query.get("limit", ["100"])) != 1:
                raise ValueError()
            limit = int(query.get("limit", ["100"])[0])
            if not 1 <= limit <= 500:
                raise ValueError()
        except ValueError:
            return self.answer(400, {"ok": False, "error": "invalid_limit"})
        return self.answer(200, dict(ok=True, **binding.ledger.listing(limit)))

    def changes(self, raw_query):
        try:
            query = parse_qs(raw_query, strict_parsing=True, keep_blank_values=True)
            if set(query) - {"cursor", "waitMs"} or any(len(v) != 1 for v in query.values()):
                raise ValueError()
            cursor = query.get("cursor", [""])[0]
            wait_ms = int(query.get("waitMs", ["25000"])[0])
            if len(cursor) > 128 or not 0 <= wait_ms <= 25000:
                raise ValueError()
        except ValueError:
            return self.answer(400, {"ok": False, "error": "invalid_change_query"})
        if not self.server.change_waiters.acquire(blocking=False):
            return self.answer(429, {"ok": False, "error": "change_waiter_capacity"})
        try:
            return self.answer(200, dict(ok=True, **self.server.registry.changes.read(cursor, wait_ms)))
        finally:
            self.server.change_waiters.release()

    def do_POST(self):
        if not self.authorized():
            return
        binding, action = self.route(self.path)
        if binding is None or action not in ("input", "attachments", "mirror-acks"):
            return self.answer(404, {"ok": False, "error": "route_not_found"})
        if action == "mirror-acks":
            # Acknowledgements only record transport outcomes, so they stay open
            # while a binding is paused or revoked; they can never cause a send.
            return self.mirror_ack(binding)
        if binding.state != "enabled":
            status = {"disabled": 503, "revoked": 410, "refused": 503}[binding.state]
            return self.answer(status, {"ok": False, "error": binding.error or "binding_" + binding.state})
        if action == "attachments":
            return self.upload(binding)
        return self.intake(binding)

    def intake(self, binding):
        config = binding.config
        try:
            body = self.json_body(MAX_INPUT_BYTES)
        except (ValueError, UnicodeError):
            return self.answer(400, {"ok": False, "error": "invalid_input"})
        # The authenticated backend is selected explicitly; forwarded flags such
        # as originOwner/controlAllowed are never treated as authorization.
        local = local_inputs.is_local(body)
        scope = {"publicThreadId": config["public_thread_id"], "chatId": config["chat_id"],
                 "accountId": config["account_id"], "source": "whatsapp_inbound", "connector": "whatsapp", "role": "user"}
        if not local and any(body.get(key) != value for key, value in scope.items()):
            return self.answer(403, {"ok": False, "error": "input_scope"})
        try:
            # V1-local input (thread, agent, mailbox, CLI, UI ...) states its own
            # origin; WhatsApp input must be a verified owner alias or member.
            author = local_inputs.author(config, body) if local else participants.author(config, body)
        except participants.Refusal as refusal:
            return self.answer(refusal.status, {"ok": False, "error": refusal.code})
        if not local:
            author["labelled"] = participants.labelled(config, author)
        public_id = body.get("publicMessageId")
        text = body.get("text")
        attachments = body.get("attachments") or []
        if not isinstance(public_id, str) or not 1 <= len(public_id) <= 256 or public_id in config["excluded_public_ids"]:
            return self.answer(409, {"ok": False, "error": "ineligible_input"})
        if attachments and not config["attachments"]:
            return self.answer(422, {"ok": False, "error": "text_only_binding"})
        if (not isinstance(text, str) or (not text.strip() and not attachments) or body.get("promptFile") or
                len(json.dumps({"client_message_id": "0" * 36,
                                "text": participants.compose({"text": text, "author": author})}).encode()) +
                instructions.reserve(config.get("instructions_path")) >
                (28672 if config["attachments"] else 32768)):  # Room for the attachment note.
            return self.answer(422, {"ok": False, "error": "text_only_pilot" if not config["attachments"] else "invalid_text"})
        try:
            data, duplicate = binding.ledger.enqueue(dict(body, attachments=attachments), author)
        except Conflict as error:
            return self.answer(409 if str(error) != "attachment_reference_invalid" else 422, {"ok": False, "error": str(error)})
        if not duplicate:
            # The idle worker sleeps up to IDLE_PASS_S; a new input is stepped now.
            binding.stop.wake()
        return self.answer(200 if duplicate else 202, {"ok": True, "duplicate": duplicate,
            "message": {"id": data["remote_id"], "role": "user", "state": "delivered", "deliveryState": "delivered",
                        "observedVia": "rust-pilot-ledger"}})

    def upload(self, binding):
        if not binding.config["attachments"]:
            return self.answer(422, {"ok": False, "error": "text_only_binding"})
        try:
            body = self.json_body(MAX_UPLOAD_BYTES)
            if set(body) != {"publicMessageId", "filename", "mediaType", "size", "sha256", "contentBase64"}:
                raise ValueError()
            content = base64.b64decode(body["contentBase64"], validate=True)
        except (ValueError, UnicodeError, binascii.Error, TypeError):
            return self.answer(400, {"ok": False, "error": "invalid_upload"})
        public_id, sha256 = body["publicMessageId"], body["sha256"]
        if (not isinstance(public_id, str) or not 1 <= len(public_id) <= 256 or public_id in binding.config["excluded_public_ids"] or
                not valid_filename(body["filename"]) or not isinstance(body["mediaType"], str) or len(body["mediaType"]) > 127 or
                not MEDIA_TOKEN.match(body["mediaType"]) or not isinstance(sha256, str) or not SHA256.match(sha256)):
            return self.answer(422, {"ok": False, "error": "invalid_upload"})
        if (type(body["size"]) is not int or body["size"] != len(content) or len(content) > MAX_ATTACHMENT_BYTES or
                hashlib.sha256(content).hexdigest() != sha256):
            return self.answer(422, {"ok": False, "error": "upload_integrity"})
        try:
            upload_id, duplicate = binding.ledger.stage_upload(public_id, body["filename"], body["mediaType"], content, sha256)
        except Conflict as error:
            return self.answer(409, {"ok": False, "error": str(error)})
        return self.answer(200 if duplicate else 201, {"ok": True, "duplicate": duplicate,
                                                       "upload": {"uploadId": upload_id, "sha256": sha256, "size": len(content)}})

    def mirror_ack(self, binding):
        try:
            body = self.json_body(16384)
        except (ValueError, UnicodeError):
            return self.answer(400, {"ok": False, "error": "invalid_ack"})
        text = lambda key, size=256: isinstance(body.get(key), str) and 0 < len(body[key]) <= size
        ids = body.get("connectorMessageIds", [])
        if (not text("remoteMessageId") or not text("parentPublicMessageId") or not text("localMessageId") or
                body.get("publicThreadId") != binding.config["public_thread_id"] or body.get("outcome") not in OUTCOMES or
                not isinstance(ids, list) or len(ids) > 32 or not all(isinstance(x, str) and 0 < len(x) <= 256 for x in ids) or
                any(key in body and not text(key) for key in ("outboxJobId", "deliveryState", "deliveredAt", "reason"))):
            return self.answer(400, {"ok": False, "error": "invalid_ack"})
        record = {key: body[key] for key in ("outcome", "parentPublicMessageId", "localMessageId", "outboxJobId",
                                            "deliveryState", "deliveredAt", "reason") if key in body}
        record["connectorMessageIds"] = ids
        try:
            result = binding.ledger.acknowledge(body["remoteMessageId"], record)
        except LookupError:
            return self.answer(404, {"ok": False, "error": "unknown_export"})
        except Conflict as error:
            return self.answer(409, {"ok": False, "error": str(error)})
        return self.answer(200, dict(ok=True, **result))

    def do_PUT(self):
        """Create one new binding: `PUT /bindings/<remote_thread_id>` with its document."""
        if not self.authorized():
            return
        parts = urlsplit(self.path).path.split("/")
        if len(parts) != 3 or parts[0] or parts[1] != "bindings" or urlsplit(self.path).query:
            return self.answer(404, {"ok": False, "error": "route_not_found"})
        try:
            body = self.json_body(MAX_INPUT_BYTES)
        except (ValueError, TypeError):
            return self.answer(400, {"ok": False, "error": "invalid_binding"})
        status, value = provisioning.create(self.server.registry, self.server.config, parts[2], body)
        return self.answer(status, value)

    def do_PATCH(self):
        if self.authorized():
            self.answer(409, {"ok": False, "error": "pilot_edits_unsupported"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config, static = load(args.config)
    session = RustSession(**{key: config[key] for key in
                             ("origin", "loopback_url", "credentials_path", "expected_owner", "expected_source")})
    registry = Registry(config, lambda conversation: RustClient(conversation_id=conversation, session=session), static)
    registry.reload()
    stop, wake = threading.Event(), threading.Event()
    server = Server(config, registry)
    reloader = threading.Thread(target=registry.run, args=(stop, wake), daemon=True)
    reloader.start()
    def shutdown(*_):
        registry.changes.close()
        stop.set()
        wake.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGHUP, lambda *_: wake.set())
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        wake.set()
        server.server_close()
        registry.shutdown()


if __name__ == "__main__":
    main()
