import { claudePollingDecision } from "./shell-poll-delay.js";

// No "allow" response: unrelated tools retain their existing permission flow.
let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(0);
}
try {
  const configured = Number(process.argv[2]);
  const limit = Number.isFinite(configured) && configured >= 0 ? configured : 30;
  const decision = claudePollingDecision(JSON.parse(input), limit);
  if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
} catch {
  // Pacing is advisory on malformed input; it must not change access policy.
}
