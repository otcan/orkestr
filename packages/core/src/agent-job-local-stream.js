import { localAdapterError } from "./agent-job-openai-compatible-health.js";

// Bounded SSE parser. A truncated stream, length limit or malformed completion
// cannot become a successful reply or partially execute a tool call.
export async function readLocalCompletion(response, { signal, emit = () => {} } = {}) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", content = "", bytes = 0, done = false, finish = null, usage = null;
  const calls = new Map();
  for await (const chunk of response.body) {
    signal?.throwIfAborted();
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw localAdapterError("local_response_too_large", { kind: "task" });
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1 || (boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
      const crlf = buffer.slice(boundary, boundary + 4) === "\r\n\r\n";
      const lines = buffer.slice(0, boundary).split(/\r?\n/); buffer = buffer.slice(boundary + (crlf ? 4 : 2));
      const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { done = true; continue; }
      if (done) throw localAdapterError("local_stream_invalid", { kind: "task" });
      let event;
      try { event = JSON.parse(data); } catch { throw localAdapterError("local_stream_invalid", { kind: "task" }); }
      if (event.error) throw localAdapterError("local_stream_provider_error");
      if (event.usage) usage = event.usage;
      if ((event.choices || []).length > 1) throw localAdapterError("local_multiple_choices", { kind: "task" });
      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        if (typeof delta.content !== "string") throw localAdapterError("local_stream_invalid", { kind: "task" });
        content += delta.content; emit({ type: "message.delta", text: delta.content });
      }
      for (const part of delta.tool_calls || []) {
        if (part.index !== 0) throw localAdapterError("local_parallel_tools_unsupported", { kind: "task" });
        const current = calls.get(part.index) || { name: "", arguments: "" };
        current.name += part.function?.name || "";
        current.arguments += part.function?.arguments || "";
        calls.set(part.index, current);
      }
    }
  }
  signal?.throwIfAborted();
  decoder.decode();
  if (!done || !["stop", "tool_calls"].includes(finish) || buffer.trim()) throw localAdapterError("local_completion_incomplete", { kind: "task" });
  if (usage) emit({ type: "usage", inputTokens: Number(usage.prompt_tokens || 0), outputTokens: Number(usage.completion_tokens || 0) });
  return { content, calls: [...calls.values()], finish };
}
