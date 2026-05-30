import fs from "node:fs/promises";
import path from "node:path";
import { listTimersForPrincipal } from "./timers.js";
import { whereAmI } from "./whereiam.js";
import { fileBrowserRootsForPrincipal, listFilesForPrincipal } from "./workspace-files.js";

function clean(value) {
  return String(value || "").trim();
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function scopedFilePath(rawPath = "", principal = {}, env = process.env) {
  const roots = await fileBrowserRootsForPrincipal(principal, env);
  const requested = clean(rawPath);
  const resolved = path.resolve(requested || roots[0]?.path || "");
  if (!roots.some((root) => pathInside(root.path || root, resolved))) {
    const error = new Error("file_path_forbidden");
    error.statusCode = 403;
    throw error;
  }
  return resolved;
}

function safeText(value = "", max = 60_000) {
  return String(value || "").slice(0, max);
}

export function tenantApiAgentToolDefinitions() {
  return [
    {
      type: "function",
      name: "orkestr_whereiam",
      description: "Return this tenant's scoped Orkestr runtime context, capabilities, thread, and workspace.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_files",
      description: "List files and directories inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional absolute or scoped path to list." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_read_file",
      description: "Read a UTF-8 text file inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_write_file",
      description: "Write a UTF-8 text file inside this tenant's allowed file roots.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          text: { type: "string", description: "UTF-8 text content to write." },
        },
        required: ["path", "text"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_list_timers",
      description: "List timers visible to this tenant.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

export async function runTenantApiAgentTool(name = "", args = {}, context = {}, env = process.env) {
  const principal = context.principal || null;
  const thread = context.thread || null;
  const tool = clean(name);
  if (tool === "orkestr_whereiam") {
    return whereAmI({ threadId: thread?.id || "", cwd: thread?.cwd || thread?.workspace || "", principal }, env);
  }
  if (tool === "orkestr_list_files") {
    return listFilesForPrincipal(clean(args.path), principal, env);
  }
  if (tool === "orkestr_read_file") {
    const filePath = await scopedFilePath(args.path, principal, env);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      const error = new Error("not_a_file");
      error.statusCode = 400;
      throw error;
    }
    if (stats.size > 256 * 1024) {
      const error = new Error("file_too_large");
      error.statusCode = 413;
      throw error;
    }
    return {
      path: filePath,
      text: await fs.readFile(filePath, "utf8"),
      size: stats.size,
    };
  }
  if (tool === "orkestr_write_file") {
    const filePath = await scopedFilePath(args.path, principal, env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, safeText(args.text), "utf8");
    const stats = await fs.stat(filePath).catch(() => null);
    return { ok: true, path: filePath, size: stats?.size ?? null };
  }
  if (tool === "orkestr_list_timers") {
    return { timers: await listTimersForPrincipal(principal, env) };
  }
  const error = new Error("api_agent_tool_not_allowed");
  error.statusCode = 403;
  throw error;
}
