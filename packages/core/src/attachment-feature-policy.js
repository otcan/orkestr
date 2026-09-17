export function attachmentFeaturePolicy(env = process.env) {
  const enabled = key => !["0", "false", "off"].includes(String(env[key] || "").trim().toLowerCase());
  return {
    eagerUploads: enabled("ORKESTR_EAGER_UPLOADS_ENABLED"),
    pastedAttachments: enabled("ORKESTR_PASTED_ATTACHMENTS_ENABLED"),
    textPreview: enabled("ORKESTR_TEXT_PREVIEW_ENABLED"),
    archivePreview: enabled("ORKESTR_ARCHIVE_PREVIEW_ENABLED"),
  };
}
