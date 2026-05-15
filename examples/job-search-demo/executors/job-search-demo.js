export const executorAdapter = {
  id: "job-search-demo",
  label: "Job Search Demo Executor",
  description: "Deterministic executor for the public job-search assistant demo.",
  async run({ message }) {
    const request = message.promptFile ? `prompt file ${message.promptFile}` : `"${message.text}"`;
    return {
      output: [
        "Job-search demo complete.",
        "",
        `Incoming request: ${request}`,
        "",
        "Recruiting lead: mock senior AI engineer outreach from a relevant company.",
        "Why it matters: the message asks for agentic tooling experience and points to Codex-style deployment work.",
        "Suggested next action: ask for role scope, hiring timeline, and whether they are open to founder/acquihire conversations.",
        "",
        "Draft reply:",
        "Thanks for reaching out. I am building local-first agent infrastructure around Codex, WhatsApp, Gmail, browsers, and timers. Happy to compare the role scope with what I am already shipping.",
      ].join("\n"),
    };
  },
};
