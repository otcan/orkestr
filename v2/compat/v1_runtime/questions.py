"""One durable question export per native payload, shared by both progress readers."""
import time
import uuid

QUESTION_PREFIX = "❓ Question while I keep working:\n\n"
QUESTION_LABEL = "Question"
QUESTION_SCAN_LIMIT = 1024


def export_question(worker, data, payload_id, text, run_id):
    """Return True for a question; its post identity prevents duplicate transport."""
    if not isinstance(text, str) or not text.startswith(QUESTION_PREFIX) or not text[len(QUESTION_PREFIX):].strip():
        return False
    seen = data.setdefault('question_payloads', [])
    if payload_id in seen or len(seen) >= QUESTION_SCAN_LIMIT:
        return True
    uuid.UUID(payload_id)
    worker.ledger.enqueue_post(dict(id=payload_id, author='assistant_question', label=QUESTION_LABEL,
        text=text, provider=None, model=None, created_ms=int(time.time()*1000)), worker.provider_identity(run_id=run_id))
    seen.append(payload_id)
    return True
