function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asksToConnect(value = "") {
  return /\b(connect|sign in|signin|log in|login|authorize|authenticate|link)\b/.test(value);
}

export function missingTenantCapabilityReply(text = "", capabilities = {}) {
  const value = lower(text);
  if (asksToConnect(value)) return "";
  if (/\bgmail\b|google mail/.test(value) && capabilities.gmail !== true) {
    return "Gmail is not connected or enabled for this chat yet. You can ask to connect Gmail from this chat after the parent Gmail app is configured.";
  }
  if (/\boutlook\b|microsoft mail|office mail/.test(value) && capabilities.outlook !== true) {
    return "Outlook is not connected or enabled for this chat yet. You can ask to connect Outlook from this chat after the parent Outlook app is configured.";
  }
  if (/\blinkedin\b|managed desktop|browser desktop|desktop\b/.test(value) && capabilities.linkedin !== true && capabilities.desktopLeases !== true && capabilities.virtualBrowsers !== true) {
    return "The managed desktop is not connected or enabled for this chat yet. Ask to connect a managed desktop before using browser-based skills.";
  }
  if (/\bfile\b|\bfiles\b|document/.test(value) && capabilities.files !== true) {
    return "Files are not connected or enabled for this chat yet. Ask to connect files before I browse or manage documents.";
  }
  return "";
}
