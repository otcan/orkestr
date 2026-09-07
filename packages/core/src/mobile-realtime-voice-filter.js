const FILLER_TOKENS = new Set([
  "ah", "eh", "e", "ee", "eee", "uh", "um", "uhm", "erm", "er",
  "hm", "hmm", "mm", "mhm", "ıh", "ıı", "ııı", "şey", "äh", "ähm", "öö",
]);

const ELONGATED_FILLER_TOKENS = new Set(["ah", "eh", "e", "uh", "um", "hm", "m", "ı", "ıh", "äh", "ähm", "ö"]);

function collapsedRepeats(value = "") {
  let result = "";
  for (const character of String(value)) {
    if (!result.endsWith(character)) result += character;
  }
  return result;
}

function fillerToken(value = "") {
  const token = String(value || "").trim().toLocaleLowerCase();
  if (!token) return true;
  if (FILLER_TOKENS.has(token)) return true;
  const collapsed = collapsedRepeats(token);
  return collapsed.length < token.length && ELONGATED_FILLER_TOKENS.has(collapsed);
}

/**
 * Rejects filler-only finalized audio transcripts without guessing at intent.
 * Any non-filler word makes the utterance substantive (for example, “um stop”).
 */
export function substantiveMobileVoiceTranscript(value = "") {
  const tokens = String(value || "").normalize("NFKC").toLocaleLowerCase().match(/\p{L}+/gu) || [];
  return tokens.length > 0 && tokens.some((token) => !fillerToken(token));
}
