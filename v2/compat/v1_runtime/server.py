"""Loopback-only V1 compatibility surface. This process never sends WhatsApp."""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import signal
import threading
from urllib.parse import parse_qs, urlsplit

from .config import load
from .ledger import Conflict, Ledger
from .rust_client import RustClient
from .worker import Worker


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, config, ledger):
        super().__init__(("127.0.0.1", config["listen_port"]), Handler)
        self.config, self.ledger = config, ledger


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

    def do_GET(self):
        if not self.authorized():
            return
        target = urlsplit(self.path)
        config = self.server.config
        if target.path == "/health" and not target.query:
            current = self.server.ledger.next_input()
            return self.answer(200, {"ok": True, "enabled": config["enabled"],
                                     "phase": current["phase"] if current else "idle",
                                     "blocked": bool(current and current.get("blocked"))})
        prefix = "/threads/" + config["remote_thread_id"]
        if target.path != prefix + "/messages":
            return self.answer(404, {"ok": False, "error": "route_not_found"})
        try:
            query = parse_qs(target.query, strict_parsing=True)
            if set(query) - {"limit"} or len(query.get("limit", ["100"])) != 1:
                raise ValueError()
            limit = int(query.get("limit", ["100"])[0])
            if not 1 <= limit <= 500:
                raise ValueError()
        except ValueError:
            return self.answer(400, {"ok": False, "error": "invalid_limit"})
        return self.answer(200, {"ok": True, "messages": self.server.ledger.messages(limit)})

    def do_POST(self):
        if not self.authorized():
            return
        config = self.server.config
        expected = "/threads/" + config["remote_thread_id"] + "/input"
        if self.path != expected:
            return self.answer(404, {"ok": False, "error": "route_not_found"})
        if not config["enabled"]:
            return self.answer(503, {"ok": False, "error": "pilot_disabled"})
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not 1 <= int(lengths[0]) <= 65536 or self.headers.get_content_type() != "application/json":
                raise ValueError()
            raw = self.rfile.read(int(lengths[0]))
            if len(raw) != int(lengths[0]):
                raise ValueError()
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            return self.answer(400, {"ok": False, "error": "invalid_input"})
        # The authenticated backend is selected explicitly; forwarded flags such
        # as originOwner/controlAllowed are never treated as authorization.
        scope = {"publicThreadId": config["public_thread_id"], "chatId": config["chat_id"],
                 "accountId": config["account_id"], "source": "whatsapp_inbound", "connector": "whatsapp", "role": "user"}
        principal = body.get("externalPrincipal")
        principal_scope = {"connector": "whatsapp", "accountId": config["account_id"], "chatId": config["chat_id"], "threadId": config["public_thread_id"]}
        sender = body.get("senderParticipantId")
        owner_verified = (isinstance(principal, dict) and
            all(principal.get(key) == value for key, value in principal_scope.items()) and
            sender in config["allowed_principals"] and
            all(value == sender for value in (body.get("from"), principal.get("senderId"), principal.get("participantId"))) and
            body.get("senderTrustLevel") == "owner" and body.get("senderEffectiveRole") == "owner")
        if any(body.get(key) != value for key, value in scope.items()) or not owner_verified:
            return self.answer(403, {"ok": False, "error": "input_scope"})
        public_id = body.get("publicMessageId")
        text = body.get("text")
        if not isinstance(public_id, str) or not 1 <= len(public_id) <= 256 or public_id in config["excluded_public_ids"]:
            return self.answer(409, {"ok": False, "error": "ineligible_input"})
        if not isinstance(text, str) or not text.strip() or len(json.dumps({"client_message_id": "0" * 36, "text": text}).encode()) > 32768 or body.get("attachments") or body.get("promptFile"):
            return self.answer(422, {"ok": False, "error": "text_only_pilot"})
        try:
            data, duplicate = self.server.ledger.enqueue(body)
        except Conflict as error:
            return self.answer(409, {"ok": False, "error": str(error)})
        return self.answer(200 if duplicate else 202, {"ok": True, "duplicate": duplicate,
            "message": {"id": data["remote_id"], "role": "user", "state": "delivered", "deliveryState": "delivered", "observedVia": "rust-pilot-ledger"}})

    def do_PATCH(self):
        if self.authorized():
            self.answer(409, {"ok": False, "error": "pilot_edits_unsupported"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = load(args.config)
    scope_keys = ("expected_owner", "conversation_id", "public_thread_id", "chat_id", "account_id", "remote_thread_id",
                  "allowed_principals", "excluded_public_ids", "automatic_accept_roles", "outbound_role")
    ledger = Ledger(config["ledger_path"], {key: config[key] for key in scope_keys})
    client = RustClient(**{key: config[key] for key in
        ("origin", "loopback_url", "credentials_path", "expected_owner", "conversation_id", "expected_source")})
    stop = threading.Event()
    server = Server(config, ledger)
    worker_thread = None
    if config["enabled"]:
        client.ensure_login()
        worker_thread = threading.Thread(target=Worker(client, ledger).run, args=(stop,), daemon=True)
        worker_thread.start()
    def shutdown(*_):
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stop.set()
        server.server_close()
        if worker_thread:
            worker_thread.join(timeout=10)


if __name__ == "__main__":
    main()
