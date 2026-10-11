// First Setup: a personal fitness tracker you talk to. Preview only: the
// structured workout store and the progress page are specified in
// docs/setups/phase-b-wizard-and-fitness-store.md and not built yet.
export const fitnessTrackerManifest = {
  schema: "orkestr.setup/v1",
  id: "fitness-tracker",
  version: "0.1.0",
  status: "preview",
  title: "Personal fitness tracker",
  summary: "Tell it what you trained, ask what to do today, and get a short weekly progress summary.",
  requires: {
    providers: { anyOf: ["codex", "claude-code"], subscriptionOnly: true },
    channels: [
      { id: "web", required: true, purpose: "Talk to the tracker in the Orkestr thread." },
      { id: "whatsapp", required: false, purpose: "Optional: talk to it from WhatsApp once you bind a chat yourself." },
    ],
    platform: {
      alwaysOn: true,
      notes: "Scheduled check-ins only run while your Orkestr host is running.",
    },
  },
  permissions: [
    { id: "thread.create" },
    { id: "thread.mission.set" },
    { id: "timer.create" },
    { id: "state.write" },
    { id: "whatsapp.reply-owner", grantedByInstall: false },
  ],
  thread: {
    name: "Fitness tracker",
    mission: [
      "You are the owner's personal training log and coach-style assistant.",
      "When the owner reports training (for example \"squat 3x5 100kg\" or \"ran 5 km in 27 min\"), restate what you logged in one line so they can correct it.",
      "If a report is ambiguous, ask one short question instead of guessing.",
      "Answer \"what should I do today?\" from the owner's recent sessions and stated goals; prefer small, sustainable steps.",
      "You are not a doctor. Do not diagnose, give medical or nutrition prescriptions, or push through reported pain; suggest seeing a professional instead.",
      "Keep messages short. Do not message anyone other than the owner.",
    ].join("\n"),
  },
  timers: [
    {
      key: "evening-check-in",
      label: "Fitness: evening check-in",
      cadence: "daily",
      time: "19:00",
      defaultEnabled: false,
      prompt: "Evening check-in: if the owner has not logged training today, ask briefly whether they trained and what they did. If they already logged, reply NO_REPLY.",
    },
    {
      key: "weekly-summary",
      label: "Fitness: weekly summary",
      cadence: "weekly",
      time: "18:00",
      defaultEnabled: false,
      prompt: "Weekly summary: summarize the last 7 days of logged training (sessions, notable sets or distances, personal bests) in five lines or fewer, then suggest one focus for next week.",
    },
  ],
  state: {
    store: "setup-events",
    schemaVersion: 1,
    migrations: [],
    onUninstall: "retain",
  },
  uninstall: { thread: "retire" },
};
