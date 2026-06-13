import { requestJson } from "./api-client.js";

function clean(value) {
  return String(value || "").trim();
}

function positional(argv) {
  return argv.filter((value) => !String(value || "").startsWith("--"));
}

function flagValue(argv, name, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function clip(value, max = 220) {
  const text = clean(value).replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function titleFromText(value) {
  const first = clean(value).split(/\n+/)[0] || clean(value);
  return clip(first
    .replace(/^please\s+/i, "")
    .replace(/^(can you|could you)\s+/i, "")
    .replace(/[.?!]\s*$/g, ""), 96);
}

function labelsForText(value) {
  const text = clean(value).toLowerCase();
  const labels = new Set(["orkestr"]);
  if (/\bwhatsapp\b|\bwa\b/.test(text)) labels.add("whatsapp");
  if (/\bdesktop\b|\bbrowser\b|\blinkedin\b/.test(text)) labels.add("desktop");
  if (/\bjira\b|\bissue\b|\bticket\b/.test(text)) labels.add("jira");
  if (/\btest\b|\bregression\b|\be2e\b/.test(text)) labels.add("testing");
  if (/\broute|routing|binding|thread\b/.test(text)) labels.add("routing");
  return [...labels];
}

function candidateWorthy(text) {
  return /\b(add|create|fix|improve|make|prevent|warn|document|extract|migrate|gate|start|support|draft|renew|route|bind)\b/i.test(text);
}

function latestAssistantContext(messages = [], beforeCursor = Infinity) {
  return [...messages]
    .reverse()
    .find((message) =>
      message.role === "assistant" &&
      Number(message.cursor || 0) < beforeCursor &&
      clean(message.text)
    )?.text || "";
}

export function draftJiraCandidatesFromThreadHistory(payload = {}, options = {}) {
  const thread = payload.thread || {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const max = Math.max(1, Math.min(20, Number(options.max || 5) || 5));
  const userMessages = messages
    .filter((message) => message.role === "user" && clean(message.text))
    .filter((message) => candidateWorthy(message.text));
  const selected = (userMessages.length ? userMessages : messages.filter((message) => message.role === "user" && clean(message.text))).slice(-max);

  return selected.map((message) => {
    const title = titleFromText(message.text);
    const context = latestAssistantContext(messages, Number(message.cursor || Infinity));
    return {
      summary: title || `Follow up on ${clean(thread.name || thread.id || "Orkestr thread")}`,
      labels: labelsForText(`${message.text}\n${context}`),
      source: {
        threadId: clean(thread.id || payload.orkestrThreadId),
        threadName: clean(thread.name || thread.displayName || thread.bindingName),
        messageId: clean(message.id),
        chatId: clean(message.chatId || thread.binding?.chatId),
        createdAt: clean(message.createdAt),
      },
      context: [
        `Source thread: ${clean(thread.name || thread.id || "unknown")} (${clean(thread.id || payload.orkestrThreadId || "unknown")})`,
        `User request: ${clip(message.text, 600)}`,
        context ? `Recent assistant context: ${clip(context, 500)}` : "",
      ].filter(Boolean).join("\n"),
      acceptanceCriteria: [
        "Implement the requested behavior without copying private connector state, tokens, browser profiles, or personal data into the public repo.",
        "Add or update focused tests for the changed behavior.",
        "Verify the relevant Orkestr workflow through the public API or CLI path.",
      ],
    };
  });
}

function formatCandidate(candidate, index) {
  return [
    `#${index + 1} ${candidate.summary}`,
    "",
    "Labels: " + candidate.labels.join(", "),
    "",
    "Context:",
    candidate.context,
    "",
    "Acceptance criteria:",
    ...candidate.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    `Source: thread=${candidate.source.threadId || "unknown"} message=${candidate.source.messageId || "unknown"}`,
  ].join("\n");
}

async function draftCommand(argv, ctx) {
  const json = argv.includes("--json");
  const target = positional(argv)[1] || positional(argv)[0];
  const max = flagValue(argv, "--max", "5");
  if (!target) throw new Error("Usage: orkestr jira draft <thread> [--max N] [--json]");
  const payload = await requestJson(`/api/threads/${encodeURIComponent(target)}/history`, ctx);
  const candidates = draftJiraCandidatesFromThreadHistory(payload, { max });
  const result = {
    ok: true,
    mode: "draft_only",
    warning: "No Jira issues were created. Review these candidates before creating tickets.",
    candidates,
  };
  if (json) ctx.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    ctx.stdout.write(`${result.warning}\n\n`);
    ctx.stdout.write(`${candidates.map(formatCandidate).join("\n\n---\n\n") || "No candidate tasks found."}\n`);
  }
  return 0;
}

export async function jiraCommand(argv, ctx) {
  const subcommand = argv[0] || "draft";
  if (subcommand === "draft" || subcommand === "tasks") return draftCommand(argv.slice(subcommand === "draft" || subcommand === "tasks" ? 1 : 0), ctx);
  throw new Error("Usage: orkestr jira draft <thread> [--max N] [--json]");
}
