"""One durable question export per native payload, shared by both progress readers."""
import time
import uuid
import sys

QUESTION_PREFIX = "❓ Question while I keep working:\n\n"
QUESTION_LABEL = "Question"
QUESTION_SCAN_LIMIT = 1024
# Question texts kept per input to keep a commentary repeat out of progress.
QUESTION_TEXT_LIMIT = 16
QUESTION_TEXT_CHARS = 2000
# A progress update repeats a question when it adds at most this much text.
REPEAT_SLACK_CHARS = 16


def _normal(text):
    return " ".join(text.replace(QUESTION_PREFIX, " ").split()).casefold()


def repeats_question(data, text):
    """True when progress is essentially a question this input already sent;
    an update that adds more than a short lead-in is still exported."""
    progress = _normal(text).strip(" :.-")
    for question in data.get('question_texts', []):
        question = question.strip(" :.-")
        if question and question in progress and len(progress) - len(question) <= REPEAT_SLACK_CHARS:
            return True
    return False


def export_question(worker, data, payload_id, text, run_id):
    """Return True for a question; its post identity prevents duplicate transport."""
    if not isinstance(text, str) or not text.startswith(QUESTION_PREFIX) or not text[len(QUESTION_PREFIX):].strip():
        return False
    seen = data.setdefault('question_payloads', [])
    if len(seen) >= QUESTION_SCAN_LIMIT:
        if not data.get('question_cap_logged'):
            data['question_cap_logged'] = True
            print('ALERT orkestr-v2-wa-adapter question_payload_cap conversation=%s input=%s cap=%d'
                  % (getattr(worker.client,'conversation','?'),data['remote_id'],QUESTION_SCAN_LIMIT),file=sys.stderr,flush=True)
        return True
    if payload_id in seen:
        return True
    uuid.UUID(payload_id)
    body = text[len(QUESTION_PREFIX):].strip()
    # V1 heads a post by its label ("❓ Question:"); the post text is the
    # bare question, so the runtime marker is not rendered a second time.
    worker.ledger.enqueue_post(dict(id=payload_id, author='assistant_question', label=QUESTION_LABEL,
        text=body, provider=None, model=None, sourceInputId=data['remote_id'], created_ms=int(time.time()*1000)), worker.provider_identity(run_id=run_id))
    seen.append(payload_id)
    texts = data.setdefault('question_texts', [])
    if len(texts) < QUESTION_TEXT_LIMIT:
        texts.append(_normal(body)[:QUESTION_TEXT_CHARS])
    # Auto-steer treats an owner message after this as a possible answer.
    asked = data.setdefault('questions_asked', [])
    if len(asked) < 16:
        asked.append({'run_id': run_id, 'at': time.time()})
    return True
