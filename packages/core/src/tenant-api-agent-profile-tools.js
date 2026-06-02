import {
  readUserOnboardingProfileForPrincipal,
  updateUserOnboardingProfileForPrincipal,
} from "./user-onboarding.js";

function clean(value) {
  return String(value || "").trim();
}

export function tenantApiAgentProfileToolDefinitions() {
  return [
    {
      type: "function",
      name: "orkestr_get_onboarding_profile",
      description: "Return the current user's non-secret onboarding profile and setup preferences for this chat.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_update_onboarding_profile",
      description: "Save non-secret onboarding details the user shared in chat, such as preferred name, timezone, language, preferences, requested tools, and notes. Never store passwords, tokens, recovery codes, or secrets.",
      parameters: {
        type: "object",
        properties: {
          displayName: { type: "string", description: "Preferred display name, or empty string to keep unchanged." },
          timezone: { type: "string", description: "Preferred timezone, or empty string to keep unchanged." },
          locale: { type: "string", description: "Preferred language or locale, or empty string to keep unchanged." },
          preferences: { type: "string", description: "How the user wants Orkestr to behave or communicate, without secrets." },
          toolRequests: { type: "string", description: "Tools, accounts, desktops, or automations the user wants to set up, without credentials." },
          notes: { type: "string", description: "Other user-visible onboarding context, without secrets." },
        },
        required: ["displayName", "timezone", "locale", "preferences", "toolRequests", "notes"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

export async function runTenantApiAgentProfileTool(name = "", args = {}, context = {}, env = process.env) {
  const tool = clean(name);
  const principal = context.principal || null;
  if (tool === "orkestr_get_onboarding_profile") {
    return { handled: true, result: await readUserOnboardingProfileForPrincipal(principal, env) };
  }
  if (tool === "orkestr_update_onboarding_profile") {
    return { handled: true, result: await updateUserOnboardingProfileForPrincipal(args, principal, env) };
  }
  return { handled: false, result: null };
}
