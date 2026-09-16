const defaultComposerLines = 96;

function rawLines(text) {
  return String(text || "").replace(/\r/g, "").split("\n");
}

function nonemptyAfter(lines, index) {
  return lines.slice(index + 1).filter((line) => line.trim());
}

function footerLine(line) {
  const text = String(line || "").trim();
  return /\bgpt-[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?\b/i.test(text) && /(?:\u00b7|help:\/help)/i.test(text) ||
    /^dbg:\s*m:gpt-[a-z0-9_.-]+\/[a-z0-9_.-]+\s*\u00b7/i.test(text);
}

function footerIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!footerLine(lines[index])) continue;
    // A current Codex footer remains at the bottom of the viewport. Transcript
    // output after it means this is not evidence of the current composer.
    if (nonemptyAfter(lines, index).length === 0) return index;
  }
  return -1;
}

function continuationLine(line) {
  const value = String(line || "");
  return !value.trim() || /^\s{2,}/.test(value);
}

function promptBody(lines, promptIndex, boundary) {
  if (promptIndex < 0) return "";
  return lines
    .slice(promptIndex, boundary)
    .map((line, index) => index === 0
      ? line.replace(/^\s*(?:\u203a|>)\s?/, "").trim()
      : line.trim())
    .join("\n")
    .trim();
}

function placeholderDraft(value) {
  return /^Ask Codex to do anything\.?$/i.test(String(value || "").trim());
}

export function panePromptLine(line) {
  const text = String(line || "").trim();
  if (/^(?:\u203a|>)\s*Use\s+\/skills\s+to\s+list\s+available\s+skills\b/i.test(text)) return false;
  return /^(?:\u203a|>)(?:\s|$)/.test(text) && !/^(?:\u203a|>)\s*\d+[.)]/.test(text);
}

export function inspectPaneComposer(text, options = {}) {
  const maxLines = Math.max(16, Number(options.maxLines || defaultComposerLines) || defaultComposerLines);
  const lines = rawLines(text).slice(-maxLines);
  const footer = footerIndex(lines);
  const boundary = footer >= 0 ? footer : lines.length;
  let prompt = -1;
  for (let index = boundary - 1; index >= 0; index -= 1) {
    if (panePromptLine(lines[index])) {
      prompt = index;
      break;
    }
  }
  if (prompt < 0) {
    return {
      presence: false,
      draft: false,
      complete: false,
      confidence: "none",
      reason: footer >= 0 ? "footer_without_composer" : "composer_not_visible",
      body: "",
    };
  }

  const continuation = lines.slice(prompt + 1, boundary);
  const coherentContinuation = continuation.every(continuationLine);
  const terminalPrompt = footer >= 0
    ? coherentContinuation
    : nonemptyAfter(lines, prompt).length === 0;
  if (!terminalPrompt) {
    return {
      presence: false,
      draft: false,
      complete: false,
      confidence: "low",
      reason: "historical_or_clipped_prompt",
      body: "",
    };
  }

  const body = promptBody(lines, prompt, boundary);
  const draft = Boolean(body) && !placeholderDraft(body);
  return {
    presence: true,
    draft,
    complete: true,
    confidence: footer >= 0 ? "high" : "medium",
    reason: footer >= 0 ? "footer_anchored_composer" : "terminal_prompt",
    body,
  };
}

export function panePromptReady(text, options = {}) {
  const composer = inspectPaneComposer(text, options);
  if (composer.presence && composer.complete) return true;
  const lines = rawLines(text).map((line) => line.trim());
  const hint = lines.findLastIndex((line) => /^(?:\u203a|>)\s*Use\s+\/skills\s+to\s+list\s+available\s+skills\b/i.test(line));
  return hint >= 0 && lines.slice(hint + 1).some(footerLine);
}

export function panePromptHasDraft(text, options = {}) {
  return inspectPaneComposer(text, options).draft;
}

export function panePromptBodyText(text, options = {}) {
  return inspectPaneComposer(text, options).body;
}

export function publicPaneComposer(composer) {
  if (!composer || typeof composer !== "object") return null;
  return {
    presence: composer.presence === true,
    draft: composer.draft === true,
    complete: composer.complete === true,
    confidence: String(composer.confidence || "none"),
    reason: String(composer.reason || "composer_not_visible"),
  };
}
