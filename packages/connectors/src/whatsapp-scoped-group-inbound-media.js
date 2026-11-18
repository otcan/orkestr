// Which WhatsApp group attachments the scoped transport keeps and the relay
// forwards into the thread.
//
// Images as before. Documents (PDF, Office, OpenDocument, plain text, CSV,
// Markdown, JSON) take the same path: the transport stores the bytes 0600 in
// its media directory, the relay uploads them through V1's inbound-media route,
// and the thread receives them as an ordinary attachment, which a delegated
// (V2) thread imports into its attachment store. Nothing here opens, renders or
// runs a file.
//
// Audio, video and voice notes stay skipped; the transport does not download
// them. Every other type (archives, HTML, SVG, scripts, executables, unknown)
// is skipped visibly instead of attached.
//
// Size: images keep their 10 MiB ceiling. A document may be up to 16 MiB, the
// most a delegated thread accepts for one inbound message
// (REMOTE_ATTACHMENT_MAX_BYTES in whatsapp-remote-attachment-upload.js). A
// larger file is skipped here instead of failing the whole forward later.

const MIB = 1024 * 1024;

export const GROUP_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/gif', '.gif'], ['image/webp', '.webp'],
]);
export const GROUP_DOCUMENT_TYPES = new Map([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.oasis.opendocument.text', '.odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
  ['application/vnd.oasis.opendocument.presentation', '.odp'],
  ['application/rtf', '.rtf'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['text/markdown', '.md'],
  ['application/json', '.json'],
]);
export const GROUP_IMAGE_MAX_BYTES = 10 * MIB;
export const GROUP_DOCUMENT_MAX_BYTES = 16 * MIB;

export const groupMediaMimetype = value => String(value || '').split(';')[0].trim().toLowerCase();

// The policy for one declared media type, or null when it is never attached.
export function groupMediaPolicy(value) {
  const mimetype = groupMediaMimetype(value);
  const image = GROUP_IMAGE_TYPES.has(mimetype);
  if (!image && !GROUP_DOCUMENT_TYPES.has(mimetype)) return null;
  const maxBytes = image ? GROUP_IMAGE_MAX_BYTES : GROUP_DOCUMENT_MAX_BYTES;
  return {
    mimetype, maxBytes,
    kind: image ? 'image' : 'document',
    extension: (image ? GROUP_IMAGE_TYPES : GROUP_DOCUMENT_TYPES).get(mimetype),
    limitLabel: `${maxBytes / MIB} MiB`,
    fallbackName: image ? 'image' : 'document',
    attachedLabel: image ? 'Image attached' : 'Document attached',
  };
}

export const groupMediaAllowed = (mimetype, size) => {
  const policy = groupMediaPolicy(mimetype);
  return Boolean(policy) && Number.isFinite(size) && size >= 0 && size <= policy.maxBytes;
};
