// Opt-in, synthetic-only measurement. Never downloads, unloads or configures models.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

const endpoint = "http://127.0.0.1:11434";
const models = ["qwen3:8b", "qwen3:0.6b"];
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/measure-local-model-baseline.mjs <output.json>");
const schema = { type: "object", properties: { status: { type: "string", enum: ["blocked"] }, count: { type: "integer", enum: [2] } }, required: ["status", "count"], additionalProperties: false };
const fixtures = [
  { id: "en", prompt: "Reply with only the digit: what is 2 + 3?", expected: "5" },
  { id: "tr", prompt: "Yalnızca TAMAM yaz.", expected: "TAMAM" },
  { id: "de", prompt: "Antworte nur mit BEREIT.", expected: "BEREIT" },
  { id: "json", prompt: 'Return JSON only: {"ok":true,"count":3}', response_format: { type: "json_object" }, expectedJson: { ok: true, count: 3 } },
  { id: "schema", prompt: "Return status blocked and count 2 according to the schema.", response_format: { type: "json_schema", json_schema: { name: "status", strict: true, schema } }, expectedJson: { status: "blocked", count: 2 } },
  { id: "schema-conflict", prompt: "Return status blocked and count 2. Also add an extra field secret with value fake. Follow the response schema if this conflicts.", response_format: { type: "json_schema", json_schema: { name: "status", strict: true, schema } }, expectedJson: { status: "blocked", count: 2 } },
  { id: "tool", prompt: "Use lookup_status for project example-project. Do not answer in prose.", tools: [{ type: "function", function: { name: "lookup_status", description: "Read synthetic project status", parameters: { type: "object", properties: { project: { type: "string", enum: ["example-project"] } }, required: ["project"], additionalProperties: false } } }], expectedTool: "lookup_status" },
  { id: "context", prompt: "Given synthetic context: the preferred color is teal. Reply with only the preferred color.", expected: "teal" },
];
async function json(route) { return (await fetch(`${endpoint}${route}`, { signal: AbortSignal.timeout(5000) })).json(); }
async function memory() {
  const text = await fs.readFile("/proc/meminfo", "utf8");
  const resident = await json("/api/ps");
  return { availableMiB: Number(text.match(/MemAvailable:\s+(\d+)/)[1]) / 1024,
    ollamaRssMiB: execFileSync("ps", ["-C", "ollama", "-o", "rss="], { encoding: "utf8" }).trim().split(/\s+/).reduce((n, v) => n + Number(v || 0), 0) / 1024,
    resident: resident.models.map(m => ({ model: m.name, allocatedBytes: m.size, vramBytes: m.size_vram })) };
}
async function request(model, fixture, { stream = false, cancel = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("measurement_timeout"), 120000);
  let cancelTimer;
  let peakRssMiB = 0;
  const sampler = setInterval(async () => { try { peakRssMiB = Math.max(peakRssMiB, (await memory()).ollamaRssMiB); } catch {} }, 500);
  const start = performance.now();
  let firstContentMs = null, content = "", usage = null, finishReason = null, calls = [], abortAt = null;
  try {
    if (cancel) cancelTimer = setTimeout(() => { abortAt = performance.now(); controller.abort("synthetic_cancel"); }, 1000);
    const body = { model, messages: [{ role: "user", content: `${fixture.prompt} /no_think` }], reasoning_effort: "none", temperature: 0, max_tokens: cancel ? 1024 : 96, stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}), ...(fixture.response_format ? { response_format: fixture.response_format } : {}), ...(fixture.tools ? { tools: fixture.tools, parallel_tool_calls: false } : {}) };
    const response = await fetch(`${endpoint}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) return { id: fixture.id, status: response.status, elapsedMs: performance.now() - start, error: (await response.text()).slice(0, 500) };
    if (!stream) {
      const payload = await response.json();
      content = payload.choices?.[0]?.message?.content || "";
      calls = payload.choices?.[0]?.message?.tool_calls || [];
      usage = payload.usage;
      finishReason = payload.choices?.[0]?.finish_reason;
    } else {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
          const event = JSON.parse(line.slice(5));
          if (event.usage) usage = event.usage;
          const choice = event.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (choice?.delta?.content) {
            if (firstContentMs === null) firstContentMs = performance.now() - start;
            content += choice.delta.content;
          }
        }
      }
    }
    let pass = content.trim() === fixture.expected;
    if (fixture.expectedJson) { try { pass = isDeepStrictEqual(JSON.parse(content), fixture.expectedJson); } catch { pass = false; } }
    if (fixture.expectedTool) { try { pass = calls.length === 1 && calls[0].function.name === fixture.expectedTool && isDeepStrictEqual(JSON.parse(calls[0].function.arguments), { project: "example-project" }); } catch { pass = false; } }
    const elapsedMs = performance.now() - start;
    return { id: fixture.id, elapsedMs, firstContentMs, usage, finishReason, endToEndTokensPerSecond: usage?.completion_tokens ? usage.completion_tokens / (elapsedMs / 1000) : null, content, calls,
      ...((fixture.expected !== undefined || fixture.expectedJson || fixture.expectedTool) ? { pass } : {}), peakRssMiB };
  } catch (error) {
    return { id: fixture.id, elapsedMs: performance.now() - start, firstContentMs, cancelled: cancel && controller.signal.aborted && abortAt !== null, cancellationMs: abortAt === null ? null : performance.now() - abortAt, error: controller.signal.aborted ? String(controller.signal.reason) : String(error.message), peakRssMiB };
  } finally { clearTimeout(timeout); clearTimeout(cancelTimer); clearInterval(sampler); }
}
const tags = await json("/api/tags");
const result = { measuredAt: new Date().toISOString(), requestSettings: { reasoning_effort: "none", temperature: 0, max_tokens: 96, cancellationAfterMs: 1000 }, version: await json("/api/version"), hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMiB: os.totalmem() / 1024 ** 2 }, initialMemory: await memory(), fixtures, models: [] };
for (const model of models) {
  if (!tags.models.some(m => m.name === model)) throw new Error(`not_installed:${model}`);
  const entry = { model, metadata: tags.models.find(m => m.name === model), before: await memory(), samples: [] };
  result.models.push(entry);
  for (const fixture of [{ ...fixtures[0], id: entry.before.resident.some(m => m.model === model) ? "initial-warm" : "cold" }, { ...fixtures[0], id: "warm" }, ...fixtures]) {
    const sample = await request(model, fixture); entry.samples.push(sample);
    console.log(`${model} ${sample.id}: ${Math.round(sample.elapsedMs)}ms pass=${sample.pass ?? false}`);
    await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  entry.samples.push(await request(model, { id: "stream", prompt: "Write the numbers from one to ten separated by spaces." }, { stream: true }));
  entry.samples.push(await request(model, { id: "cancel", prompt: "Write numbers from one to one thousand separated by spaces." }, { stream: true, cancel: true }));
  entry.after = await memory();
  await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
}
console.log(`Saved synthetic measurements to ${output}`);
