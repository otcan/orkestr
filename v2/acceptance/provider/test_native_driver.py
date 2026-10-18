"""Independent harness safety oracles; never a provider or credential test."""
import os
import signal
import subprocess
import sys
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

from native_driver import completion_payload, protected_cleanup


class NativeDriverTests(unittest.TestCase):
    def test_sse_redirect_refuses_without_visiting_target(self):
        visited = []

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                visited.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/must-not-receive-cookie")
                self.send_header("Content-Length", "0")
                self.end_headers()

        server = HTTPServer(("127.0.0.1", 0), Redirect)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            candidate = SimpleNamespace(origin=f"http://127.0.0.1:{server.server_port}",
                                        session={"cookie": "synthetic-cookie-only"})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                completion_payload(candidate, "/synthetic", "run", "completion")
            self.assertEqual(caught.exception.code, 302)
            self.assertEqual(visited, ["/synthetic/events"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_interruptions_defer_until_owned_child_is_reaped(self):
        def abort(_number, _frame):
            raise AssertionError("cleanup interrupted")

        numbers = (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)
        previous = {number: signal.getsignal(number) for number in numbers}
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"],
                                 env={"PATH": "/usr/bin:/bin"})
        try:
            for number in numbers:
                signal.signal(number, abort)

            def cleanup():
                for number in numbers:
                    os.kill(os.getpid(), number)
                child.terminate()
                child.wait(timeout=3)
                return True

            complete, interrupted = protected_cleanup(cleanup)
            self.assertTrue(complete)
            self.assertTrue(interrupted)
            self.assertIsNotNone(child.returncode)
            for number in numbers:
                self.assertIs(signal.getsignal(number), abort)
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
