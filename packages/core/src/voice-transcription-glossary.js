// Vocabulary hints for speech-to-text plus a deterministic, offline name
// correction pass. The transcription model accepts keywords as hints, but
// unusual names can still come back phonetically spelled ("Modex" for
// "Modeks"); the correction step snaps such capitalized words back to the
// glossary spelling without an extra API call.

export const MAX_GLOSSARY_ENTRIES = 40;
export const MAX_GLOSSARY_ENTRY_LENGTH = 40;
const DEFAULT_KEYWORDS = ["Orkestr"];
const FUZZY_MIN_KEY_LENGTH = 7;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function splitCommaList(value = "") {
  return String(value || "").split(",").map(clean).filter(Boolean);
}

/**
 * Builds the keyword glossary sent as `keywords[]` and used for correction.
 * @param {{ threadName?: string; bindingName?: string; ownerDisplayName?: string; extra?: string[]; env?: Record<string, string | undefined> }} [options]
 * @returns {string[]}
 */
export function buildTranscriptionGlossary({ threadName = "", bindingName = "", ownerDisplayName = "", extra = [], env = process.env } = {}) {
  const candidates = [
    ...DEFAULT_KEYWORDS,
    threadName,
    bindingName,
    ownerDisplayName,
    ...(Array.isArray(extra) ? extra : []),
    ...splitCommaList(env.ORKESTR_TRANSCRIPTION_KEYWORDS),
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const value = clean(candidate);
    if (!value || value.length > MAX_GLOSSARY_ENTRY_LENGTH) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_GLOSSARY_ENTRIES) break;
  }
  return result;
}

/**
 * Simple phonetic key: lowercase, "ph"->"f", "ch"->"k" (as in Orchestra),
 * "x"->"ks", "c" not followed by "h" -> "k", doubled letters collapsed.
 */
export function phoneticKey(word = "") {
  return String(word || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ph/g, "f")
    .replace(/ch/g, "k")
    .replace(/x/g, "ks")
    .replace(/c(?!h)/g, "k")
    .replace(/(.)\1+/g, "$1");
}

export function editDistance(a = "", b = "") {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function correctionTargets(glossary = []) {
  return (Array.isArray(glossary) ? glossary : [])
    .map(clean)
    .filter((keyword) => keyword.length >= 4 && /^[\p{L}\p{M}]+$/u.test(keyword))
    .map((keyword) => ({ keyword, key: phoneticKey(keyword) }));
}

function isCapitalized(word = "") {
  const first = word.charAt(0);
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/**
 * Replaces capitalized words that sound like a glossary keyword. Phonetic keys
 * shorter than FUZZY_MIN_KEY_LENGTH must match exactly (so "Models"/"Modes"
 * never become "Modeks"); longer keys allow one edit ("Orkester" -> "Orkestr").
 * @param {string} text
 * @param {string[]} glossary
 * @returns {string}
 */
export function correctTranscriptNames(text = "", glossary = []) {
  const targets = correctionTargets(glossary);
  if (!targets.length || !text) return String(text || "");
  return String(text).replace(/[\p{L}][\p{L}\p{M}]*/gu, (word) => {
    if (!isCapitalized(word)) return word;
    const lower = word.toLowerCase();
    if (targets.some((target) => target.keyword.toLowerCase() === lower)) return word;
    const key = phoneticKey(word);
    let best = null;
    for (const target of targets) {
      const allowed = target.key.length >= FUZZY_MIN_KEY_LENGTH ? 1 : 0;
      if (Math.abs(target.key.length - key.length) > allowed) continue;
      const distance = editDistance(key, target.key);
      if (distance <= allowed && (!best || distance < best.distance)) best = { keyword: target.keyword, distance };
    }
    return best ? best.keyword : word;
  });
}
