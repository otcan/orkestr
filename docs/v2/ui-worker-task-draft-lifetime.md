# Worker task draft lifetime

Task forms retain editable text and the frozen uncertain create request in bounded App-owned memory, keyed by the authenticated session generation, conversation and exact parent run. Tab changes and keyed conversation/parent remounts reuse that storage. Returning to a pending request retries its original instructions, control revision and request key, even when the editable next draft has changed.

Logout, expiry and owner/session replacement erase every retained value before reusing storage. Existing component-drop and session-generation guards refuse retired request callbacks. At most 128 parent scopes are retained per page; exceeding that limit refuses a new form rather than evicting an uncertain request. This is memory-only retention: page reload does not preserve drafts.

`task_draft_lifetime` tests mount and retire real Dioxus virtual-DOM child scopes through the same storage hook used by the task form. They verify tab-like removal, distinct parents/conversations, frozen retry restoration and auth teardown. They do not execute browser input events, HTTP callbacks or the independently pinned Worker browser candidate. That candidate remains immutable and its navigation failure must be preserved; a successor requires separate browser verification.
