// The local folder control's state in words (ORK-786). The control sits in
// the composer's attach actions and always says which of these holds:
//   unsupported  this browser cannot connect a local folder at all
//   none         no folder is connected
//   permission   a remembered folder needs the owner's click to allow access
//   connecting   the tab is starting to serve a folder
//   ready        the tab serves the folder (read-only; writes ask first)
//   offline      this tab's folder worker cannot serve it right now
// Pure: it reads the relay snapshot and never touches the folder.
export const DENIED = 'The browser did not allow access to the folder. Connect it again.';

export function folderState({supported = true, view = null, saved = null, message = ''} = {}) {
  if (!supported) return {state: 'unsupported', text: 'Folder access unavailable in this browser'};
  const name = view?.folder;
  switch (view?.state) {
    case 'connected': return {state: 'ready', text: `Folder ready: “${name}” · read-only, writes ask you first`};
    case 'connecting': return {state: 'connecting', text: `Connecting folder “${name}”…`};
    case 'retrying': return {state: 'offline', text: `Folder worker offline: reconnecting “${name}”…`};
    case 'elsewhere': return {state: 'offline', text: `Folder worker offline in this tab: “${name}” is served by another tab`};
    case 'signed_out': return {state: 'offline', text: 'Folder worker offline: sign in again to serve the folder'};
    default: break;
  }
  if (saved?.name) return {state: 'permission', text: `Permission needed: allow “${saved.name}” again`};
  if (message === DENIED) return {state: 'permission', text: 'Permission needed: the browser did not allow access'};
  return {state: 'none', text: 'No folder connected'};
}
