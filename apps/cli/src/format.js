export function threadName(thread = {}) {
  return String(
    thread.bindingName ||
      thread.binding?.displayName ||
      thread.name ||
      thread.title ||
      thread.id ||
      "unnamed",
  );
}

export function threadState(thread = {}) {
  return String(thread.publicStatus || thread.status || thread.state || "unknown");
}

export function threadRuntime(thread = {}) {
  return String(thread.sessionName || thread.runtime?.sessionName || thread.paneId || thread.tmuxTarget || "-");
}

export function threadUpdatedAt(thread = {}) {
  return String(thread.lastActivityAt || thread.threadUpdatedAt || thread.updatedAt || thread.createdAt || "-");
}

export function formatThreadTable(threads = [], { numbered = false } = {}) {
  if (!threads.length) return "No Orkestr threads found.";
  const rows = threads.map((thread, index) => ({
    index: numbered ? String(index + 1) : "",
    name: threadName(thread),
    state: threadState(thread),
    runtime: threadRuntime(thread),
    updated: compactTimestamp(threadUpdatedAt(thread)),
    id: String(thread.id || ""),
  }));
  const columns = [
    numbered ? ["#", "index"] : null,
    ["NAME", "name"],
    ["STATE", "state"],
    ["RUNTIME", "runtime"],
    ["UPDATED", "updated"],
    ["ID", "id"],
  ].filter(Boolean);
  const widths = columns.map(([header, key]) => {
    const maxCell = Math.max(...rows.map((row) => printableWidth(row[key])));
    return Math.max(printableWidth(header), maxCell);
  });
  return [
    columns.map(([header], index) => header.padEnd(widths[index])).join("  "),
    ...rows.map((row) =>
      columns.map(([, key], index) => truncateCell(row[key], widths[index]).padEnd(widths[index])).join("  "),
    ),
  ].join("\n");
}

function compactTimestamp(value) {
  if (!value || value === "-") return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function printableWidth(value) {
  return String(value || "").length;
}

function truncateCell(value, width) {
  const text = String(value || "");
  if (text.length <= width || width < 8) return text;
  return `${text.slice(0, width - 1)}…`;
}
