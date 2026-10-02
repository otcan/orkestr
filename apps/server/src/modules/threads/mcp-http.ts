// HTTP helpers for the remote MCP endpoint: per-request diagnostics (method,
// tool, duration, outcome, client disconnect; never arguments or content),
// client-disconnect cancellation, and SSE responses with keep-alives for
// long-running tool calls.
import { appendEvent } from "../../../../../packages/storage/src/store.js";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export type McpRequestRecord = {
  signal: AbortSignal;
  clientClosed: () => boolean;
  finish: (outcome: string, extra?: Record<string, unknown>) => void;
};

// Starts tracking one POST /mcp request. `finish` writes a single
// `mcp_request` event; a client disconnect before `finish` aborts `signal`.
export function trackMcpRequest(request: any, response: any, { era, agentId = "" }: { era: string; agentId?: string }): McpRequestRecord {
  const startedAt = Date.now();
  const body = request?.body || {};
  const controller = new AbortController();
  let finished = false;
  let closedEarly = false;
  response.once("close", () => {
    if (!finished && !response.writableFinished) {
      closedEarly = true;
      controller.abort();
    }
  });
  return {
    signal: controller.signal,
    clientClosed: () => closedEarly,
    finish(outcome, extra = {}) {
      if (finished) return;
      finished = true;
      void appendEvent({
        type: "mcp_request",
        era,
        method: clean(body.method).slice(0, 80),
        tool: body.method === "tools/call" ? clean(body.params?.name).slice(0, 80) : null,
        agentId: agentId || null,
        durationMs: Date.now() - startedAt,
        outcome,
        clientClosed: closedEarly,
        ...extra,
      }).catch(() => {});
    },
  };
}

function rpcOutcome(payload: any) {
  if (payload?.error) return { outcome: "rpc_error", rpcErrorCode: Number(payload.error.code) || null };
  if (payload?.result?.isError) return { outcome: "tool_error" };
  return { outcome: "ok" };
}

export function sendMcpJson(response: any, record: McpRequestRecord, status: number, payload: any) {
  record.finish(payload ? rpcOutcome(payload).outcome : "accepted", { httpStatus: status, transport: "json", ...(payload ? rpcOutcome(payload) : {}) });
  if (!payload) return response.status(status).end();
  return response.status(status).json(payload);
}

// Streams one JSON-RPC response as SSE: headers and a comment go out at once,
// keep-alive comments follow every `keepAliveMs`, then the final message.
export async function streamMcpResponse(response: any, record: McpRequestRecord, run: (signal: AbortSignal) => Promise<{ status: number; body: any }>, keepAliveMs = 2000) {
  response.status(200);
  response.setHeader("content-type", "text/event-stream");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
  response.write(": stream open\n\n");
  const keepAlive = setInterval(() => {
    if (!record.clientClosed()) response.write(": keep-alive\n\n");
  }, keepAliveMs);
  try {
    const result = await run(record.signal);
    if (record.clientClosed()) {
      record.finish("client_closed", { transport: "sse" });
      return;
    }
    record.finish(rpcOutcome(result.body).outcome, { httpStatus: 200, transport: "sse", ...rpcOutcome(result.body) });
    response.write(`event: message\ndata: ${JSON.stringify(result.body)}\n\n`);
  } catch (error: any) {
    record.finish("exception", { transport: "sse", rpcErrorCode: -32603, error: clean(error?.message).slice(0, 200) });
    if (!record.clientClosed()) {
      const id = (response.req?.body || {}).id ?? null;
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } })}\n\n`);
    }
  } finally {
    clearInterval(keepAlive);
    response.end();
  }
}
