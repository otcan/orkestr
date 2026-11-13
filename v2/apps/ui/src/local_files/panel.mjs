// "Local folder" control of one conversation: grant a folder from this
// computer, see while it is connected, confirm each write, and revoke it.
// Read-only by default: the picker asks for read access only; write access
// is asked for by the browser in the owner's Allow click of a write.
// The folder handle may be remembered in this browser (IndexedDB) so the
// owner can reconnect with one click; nothing is connected without a click.
// The control lives in the composer's attach actions and always states its
// state in words (folder_state.mjs); the activity log may live elsewhere
// (`logRoot`, the conversation's Files & context drawer).
import {encryptedUploadClient} from '../attachments/encrypted_upload.mjs';
import {setTitleMark} from '../title_marks.mjs';
import {DENIED, folderState} from './folder_state.mjs';
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

export function mountLocalFiles({conversation, csrf, root, logRoot = null}, {
  picker = globalThis.showDirectoryPicker?.bind(globalThis), indexedDB = globalThis.indexedDB,
  uploader = encryptedUploadClient({conversation, csrf}), fetcher, document = globalThis.document,
  notifications = globalThis.Notification, relayOptions = {},
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
  // The state line: one status element whose words say what the control can do.
  const stateNode = ({state, text}) => make('span', {class: `local-folder-state${state === 'ready' ? ' local-folder-live' : ''}`,
    'data-state': state, role: 'status', 'aria-live': 'polite', text: state === 'ready' ? `${MARK}${text}` : text});
  root.classList.add('local-folder');
  if (typeof picker !== 'function') {
    const unsupported = folderState({supported: false});
    root.dataset.folderState = unsupported.state;
    root.replaceChildren(stateNode(unsupported), make('span', {class: 'local-folder-note', text: 'Local folders need Chrome or Edge on a computer.'}));
    logRoot?.replaceChildren();
    return {close() {}};
  }
  let live = true, relay = null, handle = null, saved = null, message = '';
  const confirmations = new Map();
  const key = `conversation:${conversation}`;
  // The tab title shows the connection ("● ") and, while a write waits for
  // the owner here, "Approve write · " (ORK-804): a hidden tab still says so.
  const title = {set(connected) {
    setTitleMark(document, 'folder', connected);
    setTitleMark(document, 'write', live && confirmations.size > 0);
  }};
  // One system notification per waiting write, only if the owner already
  // allowed notifications for this site: permission is never asked here.
  function notify(request) {
    try {
      if (notifications?.permission !== 'granted') return null;
      const notice = new notifications('Approve write', {tag: `orkestr-local-write-${request.request_id}`,
        body: `The thread wants to write \u201c${request.path}\u201d in \u201c${handle?.name || 'the folder'}\u201d. Allow or refuse it in this tab.`});
      notice.onclick = () => { try { globalThis.focus?.(); } catch { /* Focus is best effort. */ } notice.close(); };
      return notice;
    } catch { return null; }
  }
  const visibility = () => { if (document.visibilityState === 'visible') relay?.poke(); };
  document.addEventListener?.('visibilitychange', visibility);

  function confirm(request, {bytes, signal}) {
    return new Promise(resolve => {
      if (signal.aborted) { resolve('refuse'); return; }
      let preview = null;
      try { preview = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, PREVIEW_CHARS * 4)).slice(0, PREVIEW_CHARS); }
      catch { /* Not text: size and checksum only. */ }
      const entry = {request, bytes, preview, notice: null, async allow() {
        // The browser's permission prompt needs this click's user activation.
        let permission = 'denied';
        try { permission = await handle.requestPermission({mode: 'readwrite'}); } catch { /* Treated as denied. */ }
        settle(permission === 'granted' ? 'allow' : 'denied');
      }, refuse() { settle('refuse'); }};
      function settle(answer) {
        if (confirmations.get(request.request_id) !== entry) return;
        confirmations.delete(request.request_id); entry.notice?.close(); resolve(answer); render();
      }
      signal.addEventListener('abort', () => settle('refuse'), {once: true});
      confirmations.set(request.request_id, entry);
      entry.notice = notify(request);
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
    if (permission !== 'granted') { message = DENIED; render(); return; }
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

  // Polls report every two seconds. The controls and the activity log are
  // drawn separately, and each only when it changed, so a button the owner
  // is about to press is never replaced by a log update.
  const controls = make('div', {class: 'local-folder-controls'}), log = make('div', {class: 'local-folder-log'});
  root.replaceChildren(controls);
  (logRoot ?? root).append(log);
  let drawnControls = '', drawnLog = '', activityOpen = false;
  function render() {
    if (!live) return;
    const view = relay?.snapshot();
    const connected = view && ['connected', 'connecting', 'retrying'].includes(view.state);
    title.set(Boolean(connected));
    const controlState = JSON.stringify([view?.state, view?.folder, message, saved?.name ?? null, [...confirmations.keys()]]);
    if (controlState !== drawnControls) {
      drawnControls = controlState;
      const state = folderState({view, saved, message});
      root.dataset.folderState = state.state;
      controls.replaceChildren(stateNode(state), ...controlNodes(view, connected));
    }
    const working = (view?.pending ?? []).filter(item => !confirmations.has(item.request_id));
    const logState = JSON.stringify([working.map(p => p.request_id), (view?.activity ?? []).map(a => [a.id, a.outcome])]);
    if (logState !== drawnLog) {
      drawnLog = logState;
      log.replaceChildren(...logNodes(working, view?.activity ?? []));
    }
  }
  function controlNodes(view, connected) {
    const nodes = [];
    if (connected) {
      nodes.push(make('button', {type: 'button', class: 'local-folder-disconnect', onclick: () => void disconnect(), text: 'Disconnect folder'}));
    } else if (view?.state === 'elsewhere') {
      nodes.push(make('button', {type: 'button', onclick: () => void start(handle, true), text: 'Use this tab'}));
      nodes.push(make('button', {type: 'button', class: 'local-folder-disconnect', onclick: () => void disconnect(), text: 'Disconnect folder'}));
    } else {
      if (saved?.handle) nodes.push(make('button', {type: 'button', class: 'local-folder-reconnect', onclick: () => void reconnect(), text: `Reconnect \u201c${saved.name}\u201d`}));
      nodes.push(make('button', {type: 'button', class: 'local-folder-connect', onclick: () => void connect(), text: saved?.handle ? 'Choose another folder\u2026' : 'Connect folder\u2026'}));
    }
    if (message && message !== DENIED) nodes.push(make('span', {class: 'local-folder-note', role: 'status', text: message}));
    for (const entry of confirmations.values()) {
      const {request, bytes} = entry;
      const card = make('section', {class: 'local-folder-confirm', role: 'alertdialog', 'aria-label': 'Confirm write'},
        make('strong', {text: 'The thread wants to change a file'}),
        make('p', {text: `Write ${bytes.length} bytes to \u201c${request.path}\u201d in \u201c${view?.folder ?? 'the folder'}\u201d. This creates the file or replaces it.`}));
      if (entry.preview !== null) card.append(make('pre', {text: entry.preview || '(empty file)'}));
      else card.append(make('p', {text: `Binary content, SHA-256 ${request.content_sha256}.`}));
      card.append(make('button', {type: 'button', class: 'local-folder-allow', onclick: () => void entry.allow(), text: 'Allow write'}),
        make('button', {type: 'button', class: 'local-folder-refuse', onclick: () => entry.refuse(), text: 'Refuse'}));
      nodes.push(card);
    }
    return nodes;
  }
  function logNodes(working, activity) {
    if (!working.length && !activity.length) return [];
    const list = make('ul', {class: 'local-folder-activity', 'aria-label': 'Recent folder requests'});
    for (const item of working) list.append(make('li', {text: `${item.operation} ${item.path ?? item.paths.join(', ')}: working\u2026`}));
    for (const item of activity.slice(0, 5)) list.append(make('li', {text: `${item.operation} ${item.path}: ${item.outcome}`}));
    const details = make('details', activityOpen ? {open: ''} : {}, make('summary', {text: 'Folder activity'}), list);
    details.ontoggle = () => { activityOpen = details.open; };
    return [details];
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
      log.remove();
    },
  };
}
