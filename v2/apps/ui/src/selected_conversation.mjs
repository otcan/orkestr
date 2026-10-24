const pattern = /^#conversation\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/(?:chat|work|history|projects|timers|tracker|memory|live-map|settings))?$/i;
const nil = '00000000-0000-0000-0000-000000000000';
// This is a presentation pointer. Owner-authenticated discovery still gates mounting.
export function selectedConversation(hash) {
 const match = typeof hash === 'string' && pattern.exec(hash);
 return match && match[1].toLowerCase() !== nil ? match[1].toLowerCase() : null;
}
const v1Link = /^#v1-link\/(ins_[A-Za-z0-9_-]{22})\/(thr_[A-Za-z0-9_-]{22})$/;
// An old V1 deep link, redirected here by the server: [instance, thread] refs.
export function selectedV1Link(hash) {
 const match = typeof hash === 'string' && v1Link.exec(hash);
 return match ? [match[1], match[2]] : null;
}
export function conversationFragment(id) {
 const selected = selectedConversation(`#conversation/${id}`);
 if (selected === null) throw Error('Invalid conversation');
 return `#conversation/${selected}`;
}

// Views that are not a conversation (host dashboard, linked V1 chat) or a
// tab of the same conversation keep their fragment when the default
// conversation is (re)selected.
export function keepsFragment(hash, id) {
 if (typeof hash !== 'string') return false;
 if (/^#host(?:[/?]|$)/.test(hash) || /^#v1\//.test(hash)) return true;
 return id !== null && selectedConversation(hash) === selectedConversation(`#conversation/${id}`) && hash.length > `#conversation/${id}`.length;
}
