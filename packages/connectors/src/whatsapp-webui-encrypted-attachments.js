function clean(value = "") {
  return String(value || "").trim();
}

export function webUiEncryptedAttachmentDelivery(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  const protectedCount = list.filter((attachment) => attachment?.encrypted === true).length;
  return {
    attachments: protectedCount > 0 ? [] : list,
    protectedCount,
  };
}

export function appendWebUiEncryptedAttachmentNotice(text = "", protectedCount = 0) {
  if (!Number.isFinite(Number(protectedCount)) || Number(protectedCount) <= 0) return clean(text);
  const body = clean(text);
  const notice = `${Number(protectedCount)} protected attachment${Number(protectedCount) === 1 ? " is" : "s are"} available in the Orkestr WebUI.`;
  return body ? `${body}\n\n${notice}` : notice;
}
