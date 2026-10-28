// Language of a deterministic acknowledgement: the language of the message it
// answers, else the chat's configured language, else the policy's, else English.
// Same word lists as the V2 adapter's notice detector (v2/compat/v1_runtime/notices.py),
// but a marker letter counts once per word (that one smooths over history):
// a small, deterministic word and letter score; an ambiguous message counts
// for nothing, so a short "ok" never switches the language of a chat.
export const ACKNOWLEDGEMENT_LANGUAGES = ['en', 'tr', 'de'];

export const ACKNOWLEDGEMENT_TEXTS = {
  en: {text: 'Received ✓, working on it',
    queuedText: "Received, queued behind the current task in this chat; I'll answer when it finishes."},
  tr: {text: 'Alındı ✓, üzerinde çalışıyorum',
    queuedText: 'Alındı; mesaj bu sohbetteki mevcut görevin arkasında bekliyor. O bitince yanıtlayacağım.'},
  de: {text: 'Empfangen ✓, ich arbeite daran',
    queuedText: 'Empfangen, die Nachricht wartet hinter der aktuellen Aufgabe in diesem Chat. Ich antworte, sobald diese abgeschlossen ist.'},
};

const words = text => new Set(text.split(/\s+/).filter(Boolean));
const WORDS = {
  tr: words(`bir ve bu da de için ne mi mı mu mü değil lütfen tamam evet hayır yok var ben sen
    biz siz o ile ama çok daha şimdi neden nasıl nerede hangi kadar gibi sonra önce bana sana
    bunu şunu olarak olan oldu olur yap yapar yaptım misin musun mısın merhaba teşekkürler
    teşekkür sağol abi hocam şu iyi güzel bak bence acaba artık hemen hep hiç`),
  de: words(`und ich nicht ist das die der den dem ein eine einen mit auch bitte ja nein
    du wir ihr sie es zu im in auf für von noch schon aber oder wenn dann was wie wo warum
    kannst kann bin bist sind hast habe hat mal jetzt danke gut mir dir uns mich dich
    doch nur sehr hier dort gibt machen mache gemacht`),
  en: words(`the and is are you i we it this that to of for with not please yes no can
    could would should what how why where when do does did have has was were be my your
    our just now thanks thank hello hi ok okay will`),
};
const LETTERS = {tr: 'ğşıçİĞŞ', de: 'ßä'};

/** 'en', 'tr', 'de', or null when the text is too short or ambiguous. Pure. */
export function detectLanguage(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const raw = text.match(/\p{L}+/gu) || [], tokens = raw.map(w => w.toLowerCase());
  const scores = Object.fromEntries(ACKNOWLEDGEMENT_LANGUAGES.map(lang => [lang, tokens.filter(w => WORDS[lang].has(w)).length]));
  // A word with a language's own letters counts once, like a known word: a
  // single name ("Send it to Ayşe") must not switch an English chat's notice.
  for (const [lang, letters] of Object.entries(LETTERS))
    scores[lang] += raw.filter(w => [...letters].some(c => w.includes(c))).length;
  const [[best, top], [, second]] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return top >= 2 && top >= 2 * second && top > second ? best : null;
}

export function validLanguage(value) {
  return value === undefined || ACKNOWLEDGEMENT_LANGUAGES.includes(value);
}

const known = value => (ACKNOWLEDGEMENT_LANGUAGES.includes(value) ? value : null);

/** The language for an acknowledgement of `input` in `group` under `policy`. */
export function acknowledgementLanguage(input, group, policy) {
  return detectLanguage(input?.body) || known(group?.language) || known(policy?.language) || 'en';
}

/**
 * The text for `state` ('active' or 'queued'). A configured `text`/`queuedText`
 * is the wording for the policy's own `language`; any other language, and a
 * policy without a language, uses the built-in wording.
 */
export function acknowledgementText(policy, lang, state) {
  const field = state === 'queued' ? 'queuedText' : 'text';
  if (policy?.language === lang && typeof policy[field] === 'string') return policy[field];
  return (ACKNOWLEDGEMENT_TEXTS[lang] || ACKNOWLEDGEMENT_TEXTS.en)[field];
}
