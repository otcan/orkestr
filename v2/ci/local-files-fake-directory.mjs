// Synthetic FileSystemDirectoryHandle for the local folder tests. Chromium in
// CI cannot show a folder picker, so the tests hand this object to the code
// instead: Node unit tests import it, and the headless browser test installs
// its source as window.showDirectoryPicker before the page loads. It is not
// imported by the UI and never part of the UI bundle.
//
// Self-contained on purpose (no outer references): `fakeDirectory.toString()`
// must run inside the page.
export function fakeDirectory(tree, {name = 'Synthetic folder', read = 'granted', readwrite = 'prompt', grantOnRequest = true} = {}) {
  const calls = [], permissions = {read, readwrite};
  const failure = kind => new DOMException(kind, kind);
  const encode = value => (typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value));
  const normalize = value => (typeof value === 'string' || value instanceof Uint8Array
    ? {kind: 'file', bytes: encode(value), modified: 1767225600000}
    : {kind: 'directory', children: new Map(Object.entries(value).map(([key, child]) => [key, normalize(child)]))});
  const top = normalize(tree);
  const permission = mode => (mode === 'readwrite' ? permissions.readwrite : permissions.readwrite === 'granted' ? 'granted' : permissions.read);
  const need = mode => { if (permission(mode) !== 'granted') throw failure('NotAllowedError'); };
  // The real API refuses these names with a TypeError, like this fake.
  const nameable = value => typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !/[\\/]/.test(value);
  let root;
  function fileHandle(node, label) {
    return {kind: 'file', name: label,
      async getFile() { need('read'); calls.push(['getFile', label]); return new File([node.bytes], label, {lastModified: node.modified}); },
      async createWritable() {
        need('readwrite'); calls.push(['createWritable', label]);
        const parts = [];
        return {async write(data) { parts.push(encode(data)); },
          async close() {
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0; for (const part of parts) { out.set(part, at); at += part.length; }
            node.bytes = out; node.modified = Date.now(); calls.push(['written', label]);
          },
          async abort() { calls.push(['aborted', label]); }};
      },
      async queryPermission({mode = 'read'} = {}) { return permission(mode); },
      async requestPermission(options) { return root.requestPermission(options); }};
  }
  function child(node, key, kind, create) {
    if (!nameable(key)) throw new TypeError('Name is not allowed.');
    need('read');
    calls.push([kind === 'file' ? 'getFileHandle' : 'getDirectoryHandle', key]);
    let found = node.children.get(key);
    if (!found) {
      if (!create) throw failure('NotFoundError');
      need('readwrite');
      found = kind === 'file' ? {kind, bytes: new Uint8Array(0), modified: Date.now()} : {kind, children: new Map()};
      node.children.set(key, found);
      calls.push(['created', key]);
    }
    if (found.kind !== kind) throw failure('TypeMismatchError');
    return kind === 'file' ? fileHandle(found, key) : directoryHandle(found, key);
  }
  function directoryHandle(node, label) {
    return {kind: 'directory', name: label,
      async getDirectoryHandle(key, {create = false} = {}) { return child(node, key, 'directory', create); },
      async getFileHandle(key, {create = false} = {}) { return child(node, key, 'file', create); },
      async *entries() {
        need('read');
        for (const [key, value] of node.children) yield [key, value.kind === 'file' ? fileHandle(value, key) : directoryHandle(value, key)];
      },
      async queryPermission({mode = 'read'} = {}) { return permission(mode); },
      async requestPermission({mode = 'read'} = {}) {
        calls.push(['requestPermission', mode]);
        if (grantOnRequest) permissions[mode] = 'granted';
        return permission(mode);
      }};
  }
  root = directoryHandle(top, name);
  // Test inspection only.
  Object.defineProperty(root, 'fake', {value: {calls, permissions,
    text(path) {
      let node = top;
      for (const part of path.split('/')) { node = node?.children?.get(part); }
      return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null;
    }}});
  return root;
}
