import assert from "node:assert/strict";
import test from "node:test";
import { executeLinkedInMcpPlan, parseLinkedInRuntimeArgs } from "../packages/core/src/linkedin-mcp-runtime.js";

function fakeLinkedInModule() {
  return {
    createLinkedInRuntimeHandlers({ desktop }) {
      return {
        "linkedin.inspect_limits": async (input, context) => {
          const observed = await desktop.observe({ type: context.tool.name, input }, context);
          return { ok: observed.ok, evidence: observed.evidence };
        },
        "linkedin.prepare_connection_requests": async (input, context) => ({
          ok: true,
          evidence: {
            items: (input.candidates || []).map((candidate) => ({
              candidateId: candidate.candidateId,
              requiresApproval: true,
            })),
          },
          mode: context.tool.mode,
        }),
        "linkedin.send_approved_invites": async (input, context) => {
          const performed = await desktop.perform({ type: context.tool.name, input }, context);
          return performed.items?.some((item) => item.verified)
            ? { ok: true, evidence: { items: performed.items } }
            : {
                ok: false,
                blocked: true,
                blocker: {
                  code: "LINKEDIN_SEND_NOT_VERIFIED",
                  evidence: performed.evidence,
                },
              };
        },
      };
    },
    createLinkedInMcpServer({ handlers }) {
      return {
        async callTool(name, input, context = {}) {
          const mode = name.includes("send") ? "write" : name.includes("prepare") ? "prepare" : "read";
          return handlers[name](input, { ...context, tool: { name, mode } });
        },
      };
    },
  };
}

test("LinkedIn MCP runtime acquires a desktop lease and executes read/prepare calls", async () => {
  const calls = [];
  const result = await executeLinkedInMcpPlan(
    {
      contractVersion: "linkedin.mcp.v1",
      runId: "run-demo",
      calls: [
        { tool: "linkedin.inspect_limits", input: { account: "demo" } },
        {
          tool: "linkedin.prepare_connection_requests",
          input: { candidates: [{ candidateId: "candidate-1" }], templates: {} },
        },
      ],
    },
    {
      linkedinModule: fakeLinkedInModule(),
      desktopSlug: "linkedin",
      threadId: "thread-linkedin",
      acquireDesktopLeaseFn: async (slug, payload) => {
        calls.push(["acquire", slug, payload.threadId]);
        return { ok: true, lease: { desktopSlug: slug, threadId: payload.threadId } };
      },
      heartbeatDesktopLeaseFn: async (slug, threadId) => {
        calls.push(["heartbeat", slug, threadId]);
        return { ok: true };
      },
      releaseDesktopLeaseFn: async (slug, payload) => {
        calls.push(["release", slug, payload.threadId]);
        return { ok: true };
      },
      operateManagedDesktopFn: async () => ({
        ok: true,
        desktop: { slug: "linkedin" },
        page: { title: "LinkedIn", url: "https://www.linkedin.com/", bodyText: "LinkedIn home" },
      }),
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.deepEqual(calls.map((call) => call[0]), ["acquire", "heartbeat", "release"]);
});

test("LinkedIn MCP runtime fails write calls closed without verified evidence", async () => {
  const result = await executeLinkedInMcpPlan(
    {
      contractVersion: "linkedin.mcp.v1",
      runId: "run-write",
      calls: [
        {
          tool: "linkedin.send_approved_invites",
          input: { approvals: [{ candidateId: "candidate-1", approved: true }] },
        },
      ],
    },
    {
      linkedinModule: fakeLinkedInModule(),
      acquireLease: false,
      desktopAdapter: {
        async observe() {
          return { ok: true, events: [], items: [] };
        },
        async perform() {
          return {
            ok: false,
            items: [{ candidateId: "candidate-1", verified: false }],
            evidence: { code: "LINKEDIN_VISIBLE_MANUAL_SEND_REQUIRED" },
          };
        },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.results[0].result.blocker.code, "LINKEDIN_SEND_NOT_VERIFIED");
});

test("LinkedIn MCP runtime can accept preverified visible-send evidence explicitly", async () => {
  const result = await executeLinkedInMcpPlan(
    {
      contractVersion: "linkedin.mcp.v1",
      runId: "run-preverified",
      calls: [
        {
          tool: "linkedin.send_approved_invites",
          input: { approvals: [{ candidateId: "candidate-1", approved: true, verifiedSend: true }] },
        },
      ],
    },
    {
      linkedinModule: fakeLinkedInModule(),
      acquireLease: false,
      acceptPreverifiedWrites: true,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.results[0].result.evidence.items[0].verified, true);
});

test("LinkedIn MCP runtime argument parser keeps safe defaults", () => {
  const options = parseLinkedInRuntimeArgs(["--plan", "plan.json", "--desktop", "linkedin", "--continue-on-blocker"], {});
  assert.equal(options.planPath, "plan.json");
  assert.equal(options.desktopSlug, "linkedin");
  assert.equal(options.stopOnBlocker, false);
  assert.equal(options.releaseLease, true);
  assert.equal(options.acceptPreverifiedWrites, false);
});
