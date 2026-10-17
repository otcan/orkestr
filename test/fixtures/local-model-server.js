import http from "node:http";

export function completionEvents({ content = "Hello", calls = [], finish = calls.length ? "tool_calls" : "stop", done = true } = {}) {
  return [
    ...(content ? [{ choices: [{ delta: { content } }] }] : []),
    ...calls.map((call, index) => ({ choices: [{ delta: { tool_calls: [{ index, type: "function", function: call }] } }] })),
    { choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

export async function localModelServer(t, handler = () => completionEvents()) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    seen.push({ url: req.url, body, headers: req.headers });
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fake-local" }] })); return; }
    res.setHeader("content-type", "text/event-stream");
    const result = await handler(body, req, res);
    if (result !== undefined) res.end(result);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen };
}
