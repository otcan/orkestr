function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

const providerLabels = {
  gmail: "Gmail",
  outlook: "Outlook",
  jira: "Jira",
  shopify: "Shopify",
};

const providerPatterns = [
  ["gmail", /\b(?:gmail|google\s+mail|google\s+account)\b/i],
  ["outlook", /\b(?:outlook|office\s*365|microsoft\s+(?:mail|account)|ms\s+mail)\b/i],
  ["jira", /\b(?:jira|atlassian)\b/i],
  ["shopify", /\bshopify\b/i],
];

const authVerbPattern = /\b(?:connect|sign\s*in|signin|log\s*in|login|authorize|authorise|auth|authenticate|link|set\s*up|setup)\b/i;

function mentionedProvider(text = "") {
  for (const [provider, pattern] of providerPatterns) {
    if (pattern.test(text)) return provider;
  }
  return "";
}

function recentMentionedProvider(messages = [], currentMessage = {}) {
  const currentId = clean(currentMessage.id);
  for (const message of [...messages].reverse().slice(0, 8)) {
    if (currentId && clean(message.id) === currentId) continue;
    const provider = mentionedProvider(message.text || message.promptFile || "");
    if (provider) return provider;
  }
  return "";
}

function emailHint(text = "") {
  return clean(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]).toLowerCase();
}

function shopHint(text = "") {
  const explicit = text.match(/\b([a-z0-9][a-z0-9-]*(?:\.myshopify\.com)?)\b(?=\s+(?:shopify|store))/i)?.[1];
  return clean(explicit).toLowerCase();
}

export function connectorProviderLabel(provider = "") {
  return providerLabels[lower(provider)] || clean(provider) || "Connector";
}

export function connectorAuthRequestFromMessages(message = {}, messages = []) {
  const text = clean(message.text || message.promptFile || "");
  if (!authVerbPattern.test(text)) return null;
  const provider = mentionedProvider(text) || recentMentionedProvider(messages, message);
  if (!provider) return null;
  return {
    provider,
    account: emailHint(text),
    shop: provider === "shopify" ? shopHint(text) : "",
  };
}

export function formatConnectorAuthResult(provider = "", result = {}) {
  const normalized = lower(provider || result.provider);
  const label = connectorProviderLabel(normalized);
  if (normalized === "outlook") {
    const url = clean(result.verificationUriComplete || result.verificationUri);
    const code = clean(result.userCode);
    if (url && code) return `Open this Microsoft sign-in page: ${url}\n\nEnter code: ${code}`;
    if (url) return `Open this Microsoft sign-in page: ${url}`;
  }
  const url = clean(result.authorizeUrl);
  if (url) return `Open this ${label} sign-in link: ${url}`;
  return clean(result.message) || `${label} sign-in is ready.`;
}

export function formatConnectorAuthError(provider = "", error = {}) {
  const normalized = lower(provider);
  const label = connectorProviderLabel(normalized);
  const code = lower(error?.message || error);
  if (code.includes("gmail_oauth_config_required")) {
    return "Gmail sign-in is not available on this Orkestr installation yet because the Gmail app credentials are not configured.";
  }
  if (code.includes("outlook_oauth_client_id_required")) {
    return "Outlook sign-in is not available on this Orkestr installation yet because the Microsoft app credentials are not configured.";
  }
  if (code.includes("jira_oauth_config_required")) {
    return "Jira sign-in is not available on this Orkestr installation yet because the Atlassian app credentials are not configured.";
  }
  if (code.includes("shopify_oauth_config_required")) {
    return "Shopify sign-in is not available on this Orkestr installation yet because the Shopify app credentials are not configured.";
  }
  if (code.includes("shopify_shop_required")) {
    return "I need the Shopify shop domain before I can start Shopify sign-in.";
  }
  return `I could not start ${label} sign-in right now. Ask an admin to check the ${label} connector setup.`;
}
