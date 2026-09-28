import { requestJson } from "./api-client.js";

export const INTERRUPT_USAGE = 'Usage: orkestr interrupt <thread> ["<message>"] [--json]';
export const SEND_NOW_USAGE = 'Usage: orkestr send <thread> "<message>" --now [--json]';

const flagsWithValues = new Set(["--idempotency-key"]);

function positional(argv = []) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] ?? "");
    if (flagsWithValues.has(value)) {
      index += 1;
    } else if (!value.startsWith("--")) {
      values.push(value);
    }
  }
  return values;
}

function flagValue(argv = [], flag = "") {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

export function parseInterruptArgs(argv = []) {
  const values = positional(argv);
  return {
    target: values[0] || "",
    text: values.slice(1).join(" ").trim(),
    json: argv.includes("--json"),
    idempotencyKey: flagValue(argv, "--idempotency-key"),
  };
}

function interruptLabel(payload = {}, withText = false) {
  if (withText) return payload.interrupted ? "Interrupted and sent" : "Sent now";
  return payload.interrupted ? "Interrupted" : "No active turn for";
}

// POST /api/threads/:thread/interrupt. With text this is interrupt-and-send:
// Codex interrupts the turn and delivers the text next; Claude Code interrupts
// the turn and resumes the same session with the text.
async function postInterrupt(parsed, ctx) {
  const body = {
    source: "cli",
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
  };
  const payload = await requestJson(`/api/threads/${encodeURIComponent(parsed.target)}/interrupt`, {
    ...ctx,
    method: "POST",
    body,
  });
  if (parsed.json) ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else ctx.stdout.write(`${interruptLabel(payload, Boolean(parsed.text))} ${payload.orkestrThreadId || parsed.target}\n`);
  return 0;
}

export async function interruptCommand(argv, ctx) {
  const parsed = parseInterruptArgs(argv);
  if (!parsed.target) throw new Error(INTERRUPT_USAGE);
  return postInterrupt(parsed, ctx);
}

export async function sendNowCommand(argv, ctx) {
  const parsed = parseInterruptArgs(argv.filter((value) => value !== "--now"));
  if (!parsed.target || !parsed.text) throw new Error(SEND_NOW_USAGE);
  return postInterrupt(parsed, ctx);
}
