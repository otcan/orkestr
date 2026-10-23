// Keep validation work bounded within the existing 100 KiB JSON parser limit.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 10_000;
export const MCP_MAX_REQUEST_BODY_BYTES = 100 * 1024;
