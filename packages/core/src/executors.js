export const executorAdapters = [
  {
    id: "noop",
    label: "No-op executor",
    description: "Records messages without running an external agent process.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    description: "Generic Codex CLI adapter placeholder. Host-specific tmux/session logic belongs outside the public core.",
  },
];

export function getExecutorAdapter(id = "noop") {
  return executorAdapters.find((adapter) => adapter.id === id) || executorAdapters[0];
}

