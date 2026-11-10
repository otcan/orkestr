// "Local folder" control of one conversation: grant a folder from this
// computer, see while it is connected, confirm each write, and revoke it.
// Read-only by default: the picker asks for read access only; write access
// is asked for by the browser in the owner's Allow click of a write.
// The folder handle may be remembered in this browser (IndexedDB) so the
// owner can reconnect with one click; nothing is connected without a click.
import {encryptedUploadClient} from '../attachments/encrypted_upload.mjs';
import {createRelay} from './relay.mjs';

const DB = 'orkestr-local-folders', STORE = 'folders', MARK = '● ';
const PREVIEW_CHARS = 2000;

function database(indexedDB) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
// Remembering is optional: private windows, blocked storage or a handle the
// browser cannot store just mean the owner picks the folder again.
async function remembered(indexedDB, key, value) {
  if (!indexedDB) return null;
  try {
    const db = await database(indexedDB);
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, value === undefined ? 'readonly' : 'readwrite'), store = tx.objectStore(STORE);
        const request = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key);
        request.onsuccess = () => resolve(value === undefined ? request.result ?? null : null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  } catch { return null; }
}

export function mountLocalFiles({conversation, csrf, root}, {
  picker = globalThis.showDirectoryPicker?.bind(globalThis), indexedDB = globalThis.indexedDB,
  uploader = encryptedUploadClient({conversation, csrf}), fetcher, document = globalThis.document,
  relayOptions = {},
} = {}) {
  const make = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'onclick') node.onclick = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  };
  root.classList.add('local-folder');
  if (typeof picker !== 'function') {
    root.replaceChildren(make('span', {class: 'local-folder-note', text: 'Local folders need Chrome or Edge on a computer.'}));
    return {close() {}};
  }
  let live = true, relay = null, handle = null, saved = null, message = '';
  const confirmations = new Map();
  const key = `conversation:${conversation}`;
  const title = {set(on) {
    const current = document.title || '';
    if (on && !current.startsWith(MARK)) document.title = MARK + current;
    if (!on && current.startsWith(MARK)) document.title = current.slice(MARK.length);
  }};
  const visibility = () => { if (document.visibilityState === 'visible') relay?.poke(); };
  document.addEventListener?.('visibilitychange', visibility);

  function confirm(request, {bytes, signal}) {
    return new Promise(resolve => {
      const settle = answer => { confirmations.delete(request.request_id); resolve(answer); render(); };
      signal.addEventListener('abort', () => settle('refuse'), {once: true});
      let preview = null;
      try { preview = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, PREVIEW_CHARS * 4)).slice(0, PREVIEW_CHARS); }
      catch { /* Not text: size and checksum only. */ }
      confirmations.set(request.request_id, {request, bytes, preview, async allow() {
        // The browser's permission prompt needs this click's user activation.
        let permission = 'denied';
        try { permission = await handle.requestPermission({mode: 'readwrite'}); } catch { /* Treated as denied. */ }
        settle(permission === 'granted' ? 'allow' : 'denied');
      }, refuse() { settle('refuse'); }});
      render();
    });
  }
  async function start(folder, takeover) {
    await relay?.stop();
    handle = folder;
    relay = createRelay({conversation, csrf, root: folder, folderName: folder.name || 'Folder', uploader, confirm,
      ...(fetcher ? {fetcher} : {}), onChange: () => render(), ...relayOptions});
    void relay.start({takeover});
    render();
  }
  async function connect() {
    let folder;
    try { folder = await picker({id: 'orkestr-local-folder', mode: 'read'}); }
    catch (error) { message = error?.name === 'AbortError' ? '' : 'The browser did not open the folder.'; render(); return; }
    if (!live || !folder || folder.kind !== 'directory') return;
    saved = {handle: folder, name: folder.name};
    await remembered(indexedDB, key, saved);
    message = '';
    await start(folder, true);
  }
  async function reconnect() {
    if (!saved?.handle) return;
    let permission = 'denied';
    try { permission = await saved.handle.requestPermission({mode: 'read'}); } catch { /* Treated as denied. */ }
    if (permission !== 'granted') { message = 'The browser did not allow access to the folder. Connect it again.'; render(); return; }
    message = '';
    await start(saved.handle, true);
  }
  async function disconnect() {
    const current = relay;
    relay = null; handle = null;
    for (const entry of confirmations.values()) entry.refuse();
    await current?.disconnect();
    saved = null;
    await remembered(indexedDB, key, null);
    message = 'Folder disconnected. The thread can no longer reach it.';
    render();
  }

  let drawn = '', activityOpen = false;
  function render() {
    if (!live) return;
    const view = relay?.snapshot();
    const connected = view && ['connected', 'connecting', 'retrying'].includes(view.state);
    title.set(Boolean(connected));
    if (view?.state === 'signed_out') message = 'Sign in again to connect the folder.';
    // Polls report every two seconds; redraw only what changed, so a button
    // the owner is about to press is never replaced under the pointer.
    const signature = JSON.stringify([view?.state, view?.folder, message, saved?.name ?? null, [...confirmations.keys()],
      view?.pending?.map(p => p.request_id), view?.activity?.map(a => [a.id, a.outcome])]);
    if (signature === drawn) return;
    drawn = signature;
    const nodes = [];
    if (connected) {
      nodes.push(make('span', {class: 'local-folder-live', role: 'status', 'aria-live': 'polite',
        text: `${MARK}Folder “${view.folder}” connected${view.state === 'retrying' ? ' (reconnecting…)' : ''}. Read-only; writes ask you first.`}));
      nodes.push(make('button', {type: 'button', onclick: () => void disconnect(), text: 'Disconnect folder'}));
    } else if (view?.state === 'elsewhere') {
      nodes.push(make('span', {class: 'local-folder-note', role: 'status', text: 'This folder is connected in another tab.'}));
      nodes.push(make('button', {type: 'button', onclick: () => void start(handle, true), text: 'Use this tab'}));
      nodes.push(make('button', {type: 'button', onclick: () => void disconnect(), text: 'Disconnect folder'}));
    } else {
      nodes.push(make('button', {type: 'button', class: 'local-folder-connect', onclick: () => void connect(), text: 'Connect folder…'}));
      if (saved?.handle) nodes.push(make('button', {type: 'button', onclick: () => void reconnect(), text: `Reconnect “${saved.name}”`}));
    }
    if (message) nodes.push(make('span', {class: 'local-folder-note', role: 'status', text: message}));
    for (const entry of confirmations.values()) {
      const {request, bytes} = entry;
      const card = make('section', {class: 'local-folder-confirm', role: 'alertdialog', 'aria-label': 'Confirm write'},
        make('strong', {text: 'The thread wants to change a file'}),
        make('p', {text: `Write ${bytes.length} bytes to “${request.path}” in “${view?.folder ?? 'the folder'}”. This creates the file or replaces it.`}));
      if (entry.preview !== null) card.append(make('pre', {text: entry.preview || '(empty file)'}));
      else card.append(make('p', {text: `Binary content, SHA-256 ${request.content_sha256}.`}));
      card.append(make('button', {type: 'button', class: 'local-folder-allow', onclick: () => void entry.allow(), text: 'Allow write'}),
        make('button', {type: 'button', class: 'local-folder-refuse', onclick: () => entry.refuse(), text: 'Refuse'}));
      nodes.push(card);
    }
    if (view?.activity?.length || view?.pending?.length) {
      const log = make('ul', {class: 'local-folder-activity', 'aria-label': 'Recent folder requests'});
      for (const item of view.pending) if (!confirmations.has(item.request_id)) log.append(make('li', {text: `${item.operation} ${item.path ?? item.paths.join(', ')}: working…`}));
      for (const item of view.activity.slice(0, 5)) log.append(make('li', {text: `${item.operation} ${item.path}: ${item.outcome}`}));
      const details = make('details', activityOpen ? {open: ''} : {}, make('summary', {text: 'Folder activity'}), log);
      details.ontoggle = () => { activityOpen = details.open; };
      nodes.push(details);
    }
    root.replaceChildren(...nodes);
  }

  void remembered(indexedDB, key).then(value => {
    if (live && !relay && value?.handle?.kind === 'directory') { saved = value; render(); }
  });
  render();
  return {
    /** Leaving the conversation stops serving the folder in this tab. */
    close() {
      live = false;
      document.removeEventListener?.('visibilitychange', visibility);
      for (const entry of confirmations.values()) entry.refuse();
      const current = relay;
      relay = null;
      void current?.disconnect();
      title.set(false);
    },
  };
}
