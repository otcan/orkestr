// Diagnostic observations only. They never authorize an operation or establish
// saved bytes, completion, deletion, or cleanup. Raw events are never retained.
const STEPS = new Set(['not_started', 'initial_files', 'upload_input', 'upload_commit',
  'upload_confirmed', 'reload', 'reloaded_files', 'open_saved_copy', 'download_arm',
  'download_click', 'download_poll', 'download_completion', 'download_read',
  'download_compare', 'download_delete', 'download_verified', 'final_lease']);
const NOTICES = new Set(['unobserved', 'unavailable', 'foreign_origin', 'missing', 'other',
  'loading', 'refreshed', 'copy_saved', 'opened', 'offered', 'auth_expired', 'removed',
  'changed', 'request_refused', 'representation_refused', 'response_metadata_refused',
  'integrity_refused', 'scope_refused', 'disconnected']);
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;

export function attachmentDiagnostics() {
  let step = 'not_started', arm = 'not_started', begin = false, progress = 0;
  let lastProgress = 'none', recorderRefused = false, overflow = false;
  let application = {notice: 'unobserved', verify_button: 'unknown'};
  return Object.freeze({
    step(value) { if (STEPS.has(value)) step = value; },
    arm(value) { if (['pending', 'ready', 'refused'].includes(value)) arm = value; },
    accepted(event) {
      if (own(event, 'kind') === 'begin') begin = true;
      else if (own(event, 'kind') === 'progress') {
        if (progress < 64) progress++; else overflow = true;
        const state = own(event, 'state');
        lastProgress = state === 'inProgress' ? 'in_progress' : state === 'completed' ? 'completed' : 'unknown';
      }
    },
    refused() { recorderRefused = true; },
    application(value) {
      application = {notice: NOTICES.has(value?.notice) ? value.notice : 'other',
        verify_button: ['enabled', 'disabled', 'missing'].includes(value?.verify_button) ? value.verify_button : 'unknown'};
    },
    snapshot() {
      return {schema: 1, step, application: {...application}, download: {arm,
        accepted_begin: begin, accepted_progress_count: progress,
        last_accepted_progress: lastProgress, recorder_refused: recorderRefused, overflow}};
    },
  });
}

// Wrap only the existing trusted injection point. The original record callback
// must accept an attributed event before it contributes a diagnostic. Rejection
// is preserved, so this cannot manufacture a completion or suppress revocation.
export function observedDownloadManager(Base, diagnostics) {
  return class extends Base {
    constructor(options) {
      const contexts = options.contexts;
      super({...options, contexts: {...contexts,
        async arm(state, root, record, signal) {
          diagnostics.arm('pending');
          try {
            const result = await contexts.arm(state, root, async event => {
              try {
                const value = await record(event);
                diagnostics.accepted(event);
                return value;
              } catch (error) { diagnostics.refused(); throw error; }
            }, signal);
            diagnostics.arm('ready');
            return result;
          } catch (error) { diagnostics.arm('refused'); throw error; }
        },
      }});
    }
  };
}

// Runs in the owned page. Only fixed categories cross the browser boundary;
// arbitrary notices, file names, identifiers and DOM contents never do.
export function threadFilesCategory(origin) {
  if (location.origin !== origin) return {notice: 'foreign_origin', verify_button: 'unknown'};
  const sections = document.querySelectorAll('section[aria-label="Thread files"]');
  if (sections.length !== 1) return {notice: 'missing', verify_button: 'unknown'};
  const statuses = sections[0].querySelectorAll(':scope > p[role="status"]');
  const buttons = [...sections[0].querySelectorAll('button')].filter(button => button.textContent === 'Verify and download');
  const verify_button = buttons.length === 1 ? buttons[0].disabled ? 'disabled' : 'enabled' : buttons.length ? 'unknown' : 'missing';
  if (statuses.length !== 1) return {notice: 'missing', verify_button};
  const text = statuses[0].textContent;
  const values = new Map([
    ['Loading thread files…', 'loading'], ['Files refreshed.', 'refreshed'],
    ['File copy saved. It was not sent as a message.', 'copy_saved'],
    ['Files in this saved copy.', 'opened'], ['File verified and download offered.', 'offered'],
    ['Sign in again to access files', 'auth_expired'], ['File removed', 'removed'],
    ['File removed or selection changed', 'changed'], ['File selection changed', 'changed'],
    ['File request changed or unavailable', 'changed'], ['File request refused', 'request_refused'],
    ['Unexpected file representation', 'representation_refused'],
    ['File response metadata mismatch', 'response_metadata_refused'],
    ['Attachment length mismatch', 'integrity_refused'], ['Attachment digest mismatch', 'integrity_refused'],
    ['Attachment bytes invalid', 'integrity_refused'], ['Attachment bytes missing', 'integrity_refused'],
    ['Attachment read budget exceeded', 'integrity_refused'], ['Attachment metadata invalid', 'integrity_refused'],
    ['Attachment scope changed', 'scope_refused'], ['Attachment reference missing', 'scope_refused'],
    ['Files disconnected. Refresh to reconnect.', 'disconnected'],
    ['Files unavailable. Refresh to reconnect.', 'disconnected'],
  ]);
  return {notice: typeof text === 'string' && text.length <= 256 ? values.get(text) ?? 'other' : 'other', verify_button};
}

// At most one read, within the original phase's remaining budget. A local timer
// is not a transport join: the caller still closes the owned context and joins
// its work. Late rejection is observed and cannot update the frozen snapshot.
export async function sampleThreadFiles(page, origin, remainingMs, signal) {
  const unavailable = {notice: 'unavailable', verify_button: 'unknown'};
  if (!page || signal?.aborted || !Number.isFinite(remainingMs) || remainingMs <= 0) return unavailable;
  let timer;
  const work = Promise.resolve().then(() => signal?.aborted ? unavailable : page.evaluate(threadFilesCategory, origin));
  work.catch(() => {});
  try {
    return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve(unavailable), Math.min(1000, remainingMs));
    })]);
  } catch { return unavailable; }
  finally { clearTimeout(timer); }
}
