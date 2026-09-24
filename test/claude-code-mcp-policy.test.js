import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeArgs } from "../packages/core/src/claude-code-client.js";
import { claudeCodeYoloAllowedMcpTools } from "../packages/core/src/claude-code-mcp-policy.js";

const yoloThread = { claudePermissionMode: "bypassPermissions" };

test("Claude YOLO MCP allowlist is server-configured and explicit", () => {
  const env = {
    ORKESTR_CLAUDE_CODE_ALLOW_BYPASS_PERMISSIONS: "1",
    ORKESTR_CLAUDE_CODE_YOLO_ALLOWED_MCP_TOOLS: "mcp__atlassian,mcp__docs__search,mcp__atlassian",
  };
  assert.deepEqual(claudeCodeYoloAllowedMcpTools(env), ["mcp__atlassian", "mcp__docs__search"]);
  const args = claudeCodeArgs(yoloThread, {}, env);
  const allowedAt = args.indexOf("--allowedTools");
  assert.notEqual(allowedAt, -1);
  assert.equal(args[allowedAt + 1], "mcp__atlassian,mcp__docs__search");
});

test("Claude MCP allowlist is not applied outside YOLO mode", () => {
  const args = claudeCodeArgs({ claudePermissionMode: "acceptEdits" }, {}, {
    ORKESTR_CLAUDE_CODE_YOLO_ALLOWED_MCP_TOOLS: "mcp__atlassian",
  });
  assert.equal(args.includes("--allowedTools"), false);
});

test("Claude YOLO MCP allowlist rejects malformed or overbroad tool expressions", () => {
  const base = { ORKESTR_CLAUDE_CODE_ALLOW_BYPASS_PERMISSIONS: "1" };
  for (const configured of ["*", "Bash(*)", "mcp__atlassian__*", "mcp__atlassian__tool with spaces", "mcp__atlassian__read,*"]) {
    assert.throws(
      () => claudeCodeArgs(yoloThread, {}, { ...base, ORKESTR_CLAUDE_CODE_YOLO_ALLOWED_MCP_TOOLS: configured }),
      /claude_code_mcp_allowlist_invalid/,
    );
  }
});
