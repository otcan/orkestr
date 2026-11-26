// "Local folder" control of one conversation: grant a folder from this
// computer, see while it is connected and what the chat did in it, and
// revoke it. Connect (or Reconnect) asks the browser once, in that click, to
// let the site view and change the folder (ORK-810); after that a write the
// chat queues applies on its own, with no card and no browser prompt, and is
// listed in Folder activity. Disconnect stops all access at once.
// The folder handle may be remembered in this browser (IndexedDB) so the
// owner can reconnect with one click; nothing is connected without a click.
// Its full controls (state in words, folder_state.mjs; connect, reconnect,
// disconnect), the connected folder's own files and the activity log live at
// the top of the conversation's Files panel (`root`, `logRoot`; ORK-809). The
// composer has one chip (`chipRoot`): the state, and Connect or Reconnect in
// one click; while a folder is connected it links to the Files panel
// (`filesHref`). When the browser refuses (a blocked picker, a refused
// permission) the chip says why at once, beside the composer, and offers a
// fresh pick instead of repeating a Reconnect the browser keeps refusing.
import {encryptedUploadClient} from '../attachments/encrypted_upload.mjs';
import {setTitleMark} from '../title_marks.mjs';
import {listFolder} from './folder.mjs';
import {DENIED, folderState} from './folder_state.mjs';
import {createRelay} from './relay.mjs';

const DB = 'orkestr-local-folders', STORE = 'folders', MARK = '● ';

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

const sized = bytes => (Number.isSafeInteger(bytes) ? ` (${bytes.toLocaleString('en')} bytes)` : '');
const DISCONNECTED = 'Folder disconnected. The thread can no longer reach it.';
/** Entries of the connected folder shown in Files; the rest are counted. */
export const FOLDER_FILES_SHOWN = 100;

/**
 * Why the folder picker did not give a folder, in words the owner can act
 * on, with the browser's error name. '' when the owner cancelled.
 */
export function pickerFailure(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  if (name === 'AbortError') return '';
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return `The browser blocked folder access (${name}). Allow file editing for this site in the browser's site settings. On a work computer, its browser policy may block folder access.`;
  }
  return `The browser could not open the folder picker (${name}). Reload the page and try again.`;
}

const sizeLabel = bytes => (!Number.isSafeInteger(bytes) ? '' : bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
// A finished write reads "written"; a failed one "not written" and its code.
// Other requests keep their outcome ("done", an error code, "expired").
function outcomeText({operation, outcome}) {
  if (operation !== 'write' || outcome.startsWith('expired') || outcome.startsWith('written')) return outcome;
  return outcome === 'done' ? 'written' : `not written: ${outcome}`;
}

export function mountLocalFiles({conversation, csrf, root, logRoot = null, chipRoot = null, filesHref = null}, {
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
  // The state line: one status element whose words say what the control can do.
  const stateNode = ({state, text}) => make('span', {class: `local-folder-state${state === 'ready' ? ' local-folder-live' : ''}`,
    'data-state': state, role: 'status', 'aria-live': 'polite', text: state === 'ready' ? `${MARK}${text}` : text});
  root.classList.add('local-folder');
  if (typeof picker !== 'function') {
    const unsupported = folderState({supported: false});
    root.dataset.folderState = unsupported.state;
    root.replaceChildren(stateNode(unsupported), make('span', {class: 'local-folder-note',
      text: 'Local folders need Chrome or Edge on a computer. On a work computer, its browser policy may turn folder access off.'}));
    logRoot?.replaceChildren();
    // Phones and other browsers: no chip in the composer at all.
    if (chipRoot) { chipRoot.replaceChildren(); chipRoot.hidden = true; }
    return {close() {}};
  }
  let live = true, relay = null, handle = null, saved = null, message = '', writeAccess = false;
  const key = `conversation:${conversation}`;
  // The tab title shows the connection ("● ").
  const title = {set(connected) { setTitleMark(document, 'folder', connected); }};
  const visibility = () => { if (document.visibilityState === 'visible') relay?.poke(); };
  document.addEventListener?.('visibilitychange', visibility);

  async function permission(folder, mode, ask) {
    try { return await (ask ? folder.requestPermission({mode}) : folder.queryPermission?.({mode}) ?? 'granted'); }
    catch { return 'denied'; }
  }
  // In the owner's click: view and change. A browser that grants viewing
  // only leaves the folder read-only, and says so; its writes are refused.
  async function grantWrite(folder) {
    writeAccess = (await permission(folder, 'readwrite', false)) === 'granted'
      || (await permission(folder, 'readwrite', true)) === 'granted';
  }
  async function start(folder, takeover) {
    await relay?.stop();
    handle = folder;
    relay = createRelay({conversation, csrf, root: folder, folderName: folder.name || 'Folder', uploader,
      ...(fetcher ? {fetcher} : {}), onChange: () => render(), ...relayOptions});
    void relay.start({takeover});
    render();
    void showFiles();
  }
  async function connect() {
    let folder;
    try { folder = await picker({id: 'orkestr-local-folder', mode: 'readwrite'}); }
    catch (error) { message = pickerFailure(error); render(); return; }
    if (!live || !folder || folder.kind !== 'directory') return;
    await grantWrite(folder);
    saved = {handle: folder, name: folder.name};
    await remembered(indexedDB, key, saved);
    message = '';
    await start(folder, true);
  }
  async function reconnect() {
    if (!saved?.handle) return;
    // One prompt for both: reading is part of read-write access.
    if ((await permission(saved.handle, 'readwrite', true)) === 'granted') writeAccess = true;
    else if ((await permission(saved.handle, 'read', true)) === 'granted') writeAccess = false;
    else { message = DENIED; render(); return; }
    message = '';
    await start(saved.handle, true);
  }
  async function allowChanges() {
    if (!handle) return;
    writeAccess = (await permission(handle, 'readwrite', true)) === 'granted';
    render();
  }
  async function disconnect() {
    const current = relay;
    relay = null; handle = null;
    await current?.disconnect();
    saved = null;
    await remembered(indexedDB, key, null);
    message = DISCONNECTED;
    files.replaceChildren();
    render();
  }

  // The connected folder's own files, top level, read in this browser from
  // the folder the owner granted: nothing is sent anywhere. Read at connect,
  // after each write the chat made, and on Refresh.
  let listing = 0;
  async function showFiles() {
    const folder = handle, turn = ++listing;
    if (!folder || typeof folder.entries !== 'function') { files.replaceChildren(); return; }
    let nodes;
    try {
      const {entries, truncated} = await listFolder(folder, '');
      nodes = filesNodes(folder.name || 'Folder', entries, truncated);
    } catch (error) {
      nodes = [make('p', {class: 'local-folder-note', role: 'status', text: `The folder could not be listed here (${error?.code ?? 'browser_error'}).`})];
    }
    if (live && turn === listing && handle === folder) files.replaceChildren(...nodes);
  }
  function filesNodes(name, entries, truncated) {
    const sorted = [...entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1));
    const list = make('ul', {class: 'local-folder-files-list', 'aria-label': `Files in ${name}`});
    for (const entry of sorted.slice(0, FOLDER_FILES_SHOWN)) {
      const folder = entry.kind === 'directory';
      list.append(make('li', {class: 'local-folder-file', 'data-kind': folder ? 'dir' : 'file'},
        make('span', {class: 'local-folder-file-name', text: folder ? `${entry.name}/` : entry.name}),
        make('span', {class: 'local-folder-file-size', text: folder ? '' : sizeLabel(entry.size)})));
    }
    const more = sorted.length - Math.min(sorted.length, FOLDER_FILES_SHOWN);
    return [
      make('h4', {class: 'local-folder-files-title', text: `Files in \u201c${name}\u201d`}),
      make('button', {type: 'button', class: 'local-folder-refresh', onclick: () => void showFiles(), text: 'Refresh'}),
      sorted.length ? list : make('p', {class: 'local-folder-note', text: 'This folder is empty.'}),
      ...(more || truncated ? [make('p', {class: 'local-folder-note', text: `${more ? `${more} more not shown here` : 'More not shown here'}; the chat can still list them.`})] : []),
    ];
  }

  // Polls report every two seconds. The controls, the folder's files and the
  // activity log are drawn separately, and each only when it changed, so a
  // button the owner is about to press is never replaced by a log update.
  const controls = make('div', {class: 'local-folder-controls'}), log = make('div', {class: 'local-folder-log'});
  const files = make('div', {class: 'local-folder-files'});
  root.replaceChildren(controls, files);
  (logRoot ?? root).append(log);
  if (chipRoot) chipRoot.hidden = false;
  let drawnControls = '', drawnLog = '', newestWrite = null;
  function render() {
    if (!live) return;
    const view = relay?.snapshot();
    const connected = view && ['connected', 'connecting', 'retrying'].includes(view.state);
    title.set(Boolean(connected));
    const controlState = JSON.stringify([view?.state, view?.folder, message, saved?.name ?? null, writeAccess]);
    if (controlState !== drawnControls) {
      drawnControls = controlState;
      const state = folderState({view, saved, message, writable: writeAccess});
      root.dataset.folderState = state.state;
      controls.replaceChildren(stateNode(state), ...controlNodes(view, connected));
      if (!connected && !handle) files.replaceChildren();
      if (chipRoot) {
        chipRoot.dataset.folderState = state.state;
        chipRoot.replaceChildren(chipNode(state, view), ...chipNote(connected));
      }
    }
    const working = view?.pending ?? [];
    const logState = JSON.stringify([working.map(p => p.request_id), (view?.activity ?? []).map(a => [a.id, a.outcome])]);
    if (logState !== drawnLog) {
      drawnLog = logState;
      log.replaceChildren(...logNodes(working, view?.activity ?? []));
      // A write the chat made may have added a file: read the folder again.
      const written = (view?.activity ?? []).find(a => a.operation === 'write' && a.outcome === 'done')?.id ?? null;
      if (written !== newestWrite) { newestWrite = written; if (written) void showFiles(); }
    }
  }
  function controlNodes(view, connected) {
    const nodes = [];
    if (connected) {
      if (!writeAccess) nodes.push(make('button', {type: 'button', class: 'local-folder-allow-changes', onclick: () => void allowChanges(), text: 'Allow changes'}));
      nodes.push(make('button', {type: 'button', class: 'local-folder-disconnect', onclick: () => void disconnect(), text: 'Disconnect folder'}));
    } else if (view?.state === 'elsewhere') {
      nodes.push(make('button', {type: 'button', onclick: () => void start(handle, true), text: 'Use this tab'}));
      nodes.push(make('button', {type: 'button', class: 'local-folder-disconnect', onclick: () => void disconnect(), text: 'Disconnect folder'}));
    } else {
      if (saved?.handle) nodes.push(make('button', {type: 'button', class: 'local-folder-reconnect', onclick: () => void reconnect(), text: `Reconnect \u201c${saved.name}\u201d`}));
      nodes.push(make('button', {type: 'button', class: 'local-folder-connect', onclick: () => void connect(), text: saved?.handle ? 'Choose another folder\u2026' : 'Connect folder\u2026'}));
    }
    // Every refusal is said in words, here and at the composer chip.
    if (message) nodes.push(make('span', {class: `local-folder-note${failed() ? ' local-folder-failed' : ''}`, role: 'status', text: message}));
    return nodes;
  }
  // The browser refused the last Connect or Reconnect (not a Disconnect).
  const failed = () => Boolean(message) && message !== DISCONNECTED;
  // The composer's one folder item: what holds, and the one click it needs.
  // After the browser refused a Reconnect, the chip offers a fresh pick.
  function chipNode(state, view) {
    const name = view?.folder ?? saved?.name ?? 'Folder';
    const reconnectable = saved?.handle && message !== DENIED;
    if (state.state === 'none' || (state.state === 'permission' && !reconnectable)) {
      return make('button', {type: 'button', class: 'local-folder-chip', 'data-state': state.state, title: failed() ? message : 'Let this chat read and change files in a folder on this computer',
        onclick: () => void connect(), text: saved?.handle ? 'Choose folder\u2026' : 'Connect folder\u2026'});
    }
    if (state.state === 'permission') {
      return make('button', {type: 'button', class: 'local-folder-chip', 'data-state': state.state, title: state.text, onclick: () => void reconnect(), text: `Reconnect \u201c${name}\u201d`});
    }
    const text = state.state === 'ready' ? `${MARK}${name}` : state.state === 'connecting' ? `Connecting \u201c${name}\u201d\u2026` : 'Folder offline';
    const props = {class: 'local-folder-chip', 'data-state': state.state, title: state.text, text};
    return filesHref ? make('a', {...props, href: filesHref, 'aria-label': `${state.text}. Open Files.`}) : make('span', props);
  }
  // Why the last click did not connect, beside the chip, until the next try.
  function chipNote(connected) {
    if (connected || !failed()) return [];
    return [make('span', {class: 'local-folder-chip-note', role: 'status', text: message})];
  }
  // Folder activity in the Files panel: what is in progress, then every
  // recent outcome, newest first: a write says written or not written (with
  // why) and its size; expired and dropped requests stay listed.
  function logNodes(working, activity) {
    if (!working.length && !activity.length) return [];
    const list = make('ul', {class: 'local-folder-activity', 'aria-label': 'Folder activity'});
    for (const item of working) list.append(make('li', {text: `${item.operation} ${item.path ?? item.paths.join(', ')}${sized(item.content_bytes)}: working\u2026`}));
    for (const item of activity) {
      const at = new Date(item.at);
      list.append(make('li', {class: `local-folder-entry${item.operation === 'write' && item.outcome === 'done' ? ' local-folder-written' : ''}`,
        text: `${item.operation} ${item.path}${sized(item.bytes)}: ${outcomeText(item)}`},
        make('time', {class: 'local-folder-time', datetime: at.toISOString(), text: ` \u00b7 ${at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`})));
    }
    return [make('h4', {class: 'local-folder-activity-title', text: 'Folder activity'}), list];
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
      const current = relay;
      relay = null;
      void current?.disconnect();
      title.set(false);
      log.remove();
      chipRoot?.replaceChildren();
    },
  };
}
