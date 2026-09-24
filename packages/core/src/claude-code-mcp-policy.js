function clean(value = "") {
  return String(value || "").trim();
}

const allowedMcpToolPattern = /^mcp__[a-zA-Z0-9_-]{1,80}__(?:[a-zA-Z0-9_.-]{1,100}|\*)$/;

function policyError(code) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 500;
  return error;
}

export function claudeCodeYoloAllowedMcpTools(env = process.env) {
  const configured = clean(env.ORKESTR_CLAUDE_CODE_YOLO_ALLOWED_MCP_TOOLS);
  if (!configured) return [];
  const tools = [...new Set(configured.split(",").map(clean).filter(Boolean))];
  if (!tools.length || tools.length > 64 || tools.some((tool) => !allowedMcpToolPattern.test(tool))) {
    throw policyError("claude_code_mcp_allowlist_invalid");
  }
  return tools;
}
