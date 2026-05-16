import readline from "node:readline/promises";
import { formatThreadTable, threadName } from "./format.js";

export async function pickThread(threads, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!threads.length) throw new Error("No Orkestr threads are available.");
  if (threads.length === 1) return threads[0];
  if (!stdin.isTTY) {
    stdout.write(`${formatThreadTable(threads, { numbered: true })}\n`);
    throw new Error("Pass a thread name/id, or run attach from an interactive terminal.");
  }

  stdout.write(`${formatThreadTable(threads, { numbered: true })}\n\n`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question("Attach to thread number or name: ")).trim();
      const selected = matchThread(threads, answer);
      if (selected) return selected;
      stdout.write("No matching thread. Try a number, name, binding name, or thread id.\n");
    }
  } finally {
    rl.close();
  }
}

function matchThread(threads, answer) {
  const index = Number.parseInt(answer, 10);
  if (Number.isInteger(index) && String(index) === answer && threads[index - 1]) return threads[index - 1];
  return threads.find((thread) => {
    const candidates = [
      thread.id,
      thread.threadId,
      thread.codexThreadId,
      thread.bindingName,
      thread.binding?.displayName,
      thread.name,
      thread.title,
      threadName(thread),
    ].map((value) => String(value || "").trim());
    return candidates.some((candidate) => candidate && candidate === answer);
  });
}
