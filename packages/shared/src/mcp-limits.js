// GHSA-46jr-4wx8-v453: the MCP SDK validates tool arguments without a size
// bound unless the server sets maxToolInputElements (off by default). Our
// tool schemas take at most a few hundred elements (participant/event id
// lists), so this cap rejects pathological inputs before schema validation.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 2000;
export const mcpServerOptions = Object.freeze({ maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS });
