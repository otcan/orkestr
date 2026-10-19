// Plain text descriptors only. The caller must render with text nodes, never HTML.
// No save action is exposed until a separately verified byte result exists.
export function attachmentLabel(reference) {
  return Object.freeze({
    name: reference.filename,
    size: `${reference.byte_length.toLocaleString('en-US')} bytes`,
    status: reference.state === 'removed' ? 'File removed' : 'Not downloaded',
    canSave: false,
  });
}
