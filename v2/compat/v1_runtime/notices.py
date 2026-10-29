"""Adapter notices in the chat's language (English, Turkish, German).

The language is detected from the chat's own recent WhatsApp messages (owner
and member text, never timer, post or agent text). Detection is a small,
deterministic word and letter score; an ambiguous message counts for nothing.
The last few confident detections are kept in `ledger_meta` (no message text),
so a notice for an input whose text was already pruned still follows the
chat. Anything unknown falls back to English, the previous behavior.
"""
import json
import re

LANGUAGES = ("en", "tr", "de")
META_KEY = "chat_language"
RECENT = 8
# Roles whose text reflects the language people use in the chat.
CHAT_ROLES = (None, "owner", "member", "v1_owner", "v1_external")

# Notice wording rules (owner review, 2026-10-26): never blame the person or
# push work onto them, say honestly what happened, and follow the chat's
# language. A plain chat audience (members, or any chat not verified
# owner-only) gets a short non-technical notice that does not ask for a
# resend; the verified owner of an owner-only chat gets the technical reason.
TEMPLATES = {
    # A failed input after the one automatic retry (or when none was safe).
    "failure": {
        "en": "I received your message, but a technical problem kept me from answering it. "
              "I have reported it to the operator.",
        "tr": "Mesajınızı aldım ama teknik bir sorun nedeniyle yanıt veremedim; konuyu operatöre ilettim.",
        "de": "Deine Nachricht ist angekommen, aber wegen eines technischen Problems konnte ich sie nicht "
              "beantworten. Ich habe es an den Betreiber weitergegeben.",
    },
    "failure_owner": {
        "en": "Technical failure (%(reason)s): this message was not processed. The operator was alerted; "
              "resend it if it is urgent.",
        "tr": "Teknik hata (%(reason)s): bu mesaj işlenemedi. Operatöre bildirildi; acilse tekrar gönder.",
        "de": "Technischer Fehler (%(reason)s): Diese Nachricht wurde nicht verarbeitet. Der Betreiber wurde "
              "benachrichtigt; sende sie erneut, falls es dringend ist.",
    },
    # A run that may already have acted (or needs review): never retried.
    "interrupted_owner": {
        "en": "The task was interrupted before it finished (%(reason)s). It may already have done part of the "
              "work, so nothing is retried or re-sent automatically. Tell me \"try again\" to retry it.",
        "tr": "Görev bitmeden yarıda kesildi (%(reason)s). İşin bir kısmını zaten yapmış olabilir, bu yüzden hiçbir "
              "şey otomatik olarak yeniden denenmiyor veya yeniden gönderilmiyor. Yeniden denemek için "
              "\"tekrar dene\" yaz.",
        "de": "Die Aufgabe wurde vor dem Abschluss unterbrochen (%(reason)s). Sie hat womöglich schon einen Teil "
              "erledigt, deshalb wird nichts automatisch wiederholt oder erneut gesendet. Schreib "
              "\"nochmal versuchen\", um sie erneut auszuführen.",
    },
    "timer_interrupted": {
        "en": "\u23f0 %(label)s was interrupted before it finished (%(reason)s). It may already have done part of "
              "its work, so it is not retried automatically. Its later scheduled runs are not affected; "
              "the operator was alerted.",
        "tr": "\u23f0 %(label)s bitmeden yarıda kesildi (%(reason)s). İşinin bir kısmını zaten yapmış olabilir, bu "
              "yüzden otomatik olarak yeniden denenmiyor. Sonraki planlı çalışmalar etkilenmez; "
              "operatöre bildirildi.",
        "de": "\u23f0 %(label)s wurde vor dem Abschluss unterbrochen (%(reason)s). Er hat womöglich schon einen "
              "Teil erledigt, deshalb wird er nicht automatisch wiederholt. Spätere geplante Läufe sind nicht "
              "betroffen; der Betreiber wurde benachrichtigt.",
    },
    # A scheduled timer occurrence that produced no result.
    "timer_failure": {
        "en": "\u23f0 %(label)s failed (%(reason)s) and produced no result this time. Its later scheduled runs "
              "are not affected; the operator was alerted.",
        "tr": "\u23f0 %(label)s başarısız oldu (%(reason)s) ve bu sefer sonuç üretmedi. Sonraki planlı "
              "çalışmalar etkilenmez; operatöre bildirildi.",
        "de": "\u23f0 %(label)s ist fehlgeschlagen (%(reason)s) und hat diesmal kein Ergebnis geliefert. Spätere "
              "geplante Läufe sind nicht betroffen; der Betreiber wurde benachrichtigt.",
    },
    # Appended when owner messages had been steered into the failed turn.
    "steered": {
        "en": "\n\nThis also covers the %(count)d message(s) you sent while it was running.",
        "tr": "\n\nBu, görev çalışırken gönderdiğin %(count)d mesaj için de geçerli.",
        "de": "\n\nDas gilt auch für die %(count)d Nachricht(en), die du währenddessen gesendet hast.",
    },
    "continue": {
        "en": "Continuing in a new turn: the previous turn reached its time limit before it finished.",
        "tr": "Yeni bir turda devam ediliyor: önceki tur bitmeden zaman sınırına ulaştı.",
        "de": "Es geht in einem neuen Durchgang weiter: Der vorherige Durchgang hat sein Zeitlimit "
              "erreicht, bevor er fertig war.",
    },
    "steer_unknown": {
        "en": "Your message went to the running task, but I could not confirm that it arrived. The operator "
              "was alerted; if the reply does not cover it, resend it.",
        "tr": "Mesajın çalışan göreve gönderildi ama ulaştığını doğrulayamadım. Operatöre bildirildi; "
              "yanıt bunu kapsamazsa tekrar gönder.",
        "de": "Deine Nachricht ging an die laufende Aufgabe, aber ich konnte nicht bestätigen, dass sie "
              "angekommen ist. Der Betreiber wurde benachrichtigt; falls die Antwort sie nicht abdeckt, "
              "sende sie erneut.",
    },
    "steer_queued": {
        "en": "Your message could not be added to the running task, and I could not confirm it as a separate "
              "request either. The operator was alerted; if the reply does not cover it, resend it.",
        "tr": "Mesajın çalışan göreve eklenemedi ve ayrı bir istek olarak da doğrulanamadı. Operatöre "
              "bildirildi; yanıt bunu kapsamazsa tekrar gönder.",
        "de": "Deine Nachricht konnte der laufenden Aufgabe nicht hinzugefügt und auch nicht als eigene "
              "Anfrage bestätigt werden. Der Betreiber wurde benachrichtigt; falls die Antwort sie nicht "
              "abdeckt, sende sie erneut.",
    },
    "policy": {
        "en": "The model provider declined this message under its content policy (%(model)s), so there is "
              "no answer to it. No other model was used.",
        "tr": "Model sağlayıcısı bu mesajı içerik politikası gereği yanıtlamayı reddetti (%(model)s), bu "
              "yüzden bir yanıt yok. Başka bir model kullanılmadı.",
        "de": "Der Modellanbieter hat diese Nachricht wegen seiner Inhaltsrichtlinie abgelehnt "
              "(%(model)s), daher gibt es keine Antwort. Es wurde kein anderes Modell verwendet.",
    },
    "activity_running": {
        "en": "Still working on it, %(minutes)d minutes so far. No new progress in the last 10 minutes.",
        "tr": "Hâlâ üzerinde çalışılıyor, şu ana kadar %(minutes)d dakika. Son 10 dakikada yeni bir "
              "ilerleme yok.",
        "de": "Ich arbeite noch daran, bisher %(minutes)d Minuten. In den letzten 10 Minuten gab es keinen "
              "neuen Fortschritt.",
    },
    # Deep heartbeat: a Core template, never model text, no paths or reasons.
    # A Deep run ended without an accepted answer after its latest output had
    # already reached the chat as progress: that output may be the answer.
    "stopped_after_answer": {
        "en": "\u2139\ufe0f This task stopped early. If the answer above already covers your question, nothing "
              "else is needed; otherwise just ask again.",
        "tr": "\u2139\ufe0f Bu görev erken durdu. Yukarıdaki yanıt sorunu zaten karşılıyorsa başka bir şey "
              "gerekmez; karşılamıyorsa tekrar sorman yeterli.",
        "de": "\u2139\ufe0f Diese Aufgabe wurde vorzeitig beendet. Wenn die Antwort oben deine Frage schon "
              "beantwortet, ist nichts weiter nötig; sonst frag einfach noch einmal.",
    },
    "deep_heartbeat": {
        "en": "\U0001f9e0 Still working\u2026 %(minutes)d min so far, the full answer follows.",
        "tr": "\U0001f9e0 Hâlâ çalışıyorum\u2026 şu ana kadar %(minutes)d dk, tam yanıt gelecek.",
        "de": "\U0001f9e0 Ich arbeite noch\u2026 bisher %(minutes)d Min., die vollständige Antwort folgt.",
    },
    # The same heartbeat for a person's input still queued behind an earlier
    # running turn (activity.waiting): truthful about the wait, no reasons.
    "deep_heartbeat_waiting": {
        "en": "\U0001f9e0 Still on it\u2026 %(minutes)d min so far. An earlier task is finishing first, "
              "then the full answer follows.",
        "tr": "\U0001f9e0 Hâlâ üzerindeyim\u2026 şu ana kadar %(minutes)d dk. Önce önceki bir görev bitiyor, "
              "ardından tam yanıt gelecek.",
        "de": "\U0001f9e0 Ich bin dran\u2026 bisher %(minutes)d Min. Zuerst wird eine frühere Aufgabe fertig, "
              "dann folgt die vollständige Antwort.",
    },
    "activity_missing": {
        "en": "I cannot confirm that this task is still running (%(state)s, %(minutes)d minutes so far). "
              "The result is still pending, and the operator was alerted.",
        "tr": "Bu görevin hâlâ çalıştığını doğrulayamıyorum (%(state)s, şu ana kadar %(minutes)d dakika). "
              "Sonuç hâlâ bekleniyor; operatöre bildirildi.",
        "de": "Ich kann nicht bestätigen, dass diese Aufgabe noch läuft (%(state)s, bisher %(minutes)d "
              "Minuten). Das Ergebnis steht noch aus; der Betreiber wurde benachrichtigt.",
    },
}

WORDS = {
    "tr": frozenset("""bir ve bu da de için ne mi mı mu mü değil lütfen tamam evet hayır yok var ben sen
        biz siz o ile ama çok daha şimdi neden nasıl nerede hangi kadar gibi sonra önce bana sana
        bunu şunu olarak olan oldu olur yap yapar yaptım misin musun mısın merhaba teşekkürler
        teşekkür sağol abi hocam şu iyi güzel bak bence acaba artık hemen hep hiç""".split()),
    "de": frozenset("""und ich nicht ist das die der den dem ein eine einen mit auch bitte ja nein
        du wir ihr sie es zu im in auf für von noch schon aber oder wenn dann was wie wo warum
        kannst kann bin bist sind hast habe hat mal jetzt danke gut mir dir uns mich dich
        doch nur sehr hier dort gibt machen mache gemacht""".split()),
    "en": frozenset("""the and is are you i we it this that to of for with not please yes no can
        could would should what how why where when do does did have has was were be my your
        our just now thanks thank hello hi ok okay will""".split()),
}
LETTERS = {"tr": "ğşıçİĞŞ", "de": "ßä"}
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def detect(text):
    """'en', 'tr', 'de', or None when the text is too short or ambiguous. Pure."""
    if not isinstance(text, str) or not text.strip():
        return None
    words = [w.lower() for w in WORD.findall(text)]
    scores = {lang: sum(w in WORDS[lang] for w in words) for lang in LANGUAGES}
    for lang, letters in LETTERS.items():
        scores[lang] += 2 * sum(text.count(c) for c in letters)
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    (best, top), (_, second) = ranked[0], ranked[1]
    return best if top >= 2 and top >= 2 * second and top > second else None


def _recent(db):
    row = db.execute("SELECT value FROM ledger_meta WHERE key=?", (META_KEY,)).fetchone()
    try:
        value = json.loads(row[0]) if row else []
    except ValueError:
        return []
    return [v for v in value if v in LANGUAGES] if isinstance(value, list) else []


def remember(db, text, role=None):
    """Record one chat message's language, inside the caller's transaction."""
    if role not in CHAT_ROLES:
        return
    lang = detect(text)
    if lang is None:
        return
    recent = (_recent(db) + [lang])[-RECENT:]
    db.execute("INSERT INTO ledger_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               (META_KEY, json.dumps(recent)))


def chat_language(db):
    """Majority of the recent confident detections; a tie goes to the newest."""
    recent = _recent(db)
    if not recent:
        return "en"
    counts = {lang: recent.count(lang) for lang in LANGUAGES}
    top = max(counts.values())
    return next(lang for lang in reversed(recent) if counts[lang] == top)


def language_for(db, data=None):
    """The input's own text decides when it is clear; otherwise the chat's."""
    own = detect((data or {}).get("text")) if (data or {}).get("origin") is None else None
    return own or chat_language(db)


def render(lang, key, **values):
    table = TEMPLATES[key]
    return table.get(lang, table["en"]) % values


def localize(lang, text):
    """A known English notice in `lang`; any other text is returned unchanged."""
    for table in TEMPLATES.values():
        if "%" not in table["en"] and text == table["en"]:
            return table.get(lang, text)
    return text


def refusal(lang, reason, technical):
    """The closing notice of a failed input (see the wording rules above)."""
    if technical:
        return render(lang, "failure_owner", reason=reason)
    return render(lang, "failure")
