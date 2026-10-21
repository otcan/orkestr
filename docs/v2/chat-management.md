# Managing chats in the Rust UI (V1 parity)

This page lists what the owner manages per chat in V1's web UI today and where
it lives in the Rust UI.

| V1 web UI | Native or migrated chat (V2 state) | Linked V1 chat (V1 API through the server) |
| --- | --- | --- |
| Model and reasoning effort (model details dialog) | Settings tab: provider, model, effort (`PUT …/settings`, revision-guarded) | Settings: model and effort from V1's model list (`/api/v2/v1-threads/{t}/settings` → V1 `model-settings`) |
| Executor switch (Codex/Claude) | Settings tab: provider (applies at the next turn with a handoff) | not offered (see below) |
| NO_REPLY, reply prefix and footer | Settings tab | Settings: reply prefix (WhatsApp options) |
| Thread timers: list, add, pause/resume, delete | Timers tab: list; pause (disable), resume (enable), stop, rollback | Timers: list, create, edit, pause, resume, delete (`…/timers`) |
| Desktops page and leases | Settings tab: desktop binding (V1 grant holder + slugs) and leases | Settings: granted desktops and leases (read-only) |
| WhatsApp binding options (updates, footer, additional participants) | managed in the adapter binding (operator) | Settings: final answers only, hide footer, other participants and their ids |

## Rules

- Only chats the sidebar lists can be reached. Any other thread returns `404`.
- A chat whose V1 runtime is delegated to V2 is managed through its V2
  conversation. V1 writes are refused with `409 v1_thread_delegated`.
- V1's per-thread timer routes do not check that a timer belongs to the thread.
  The server checks it, and it refuses timers that V2 runs
  (`409 timer_owned_by_v2`).
- Timer creation is idempotent per request id for the lifetime of the server
  process.
- WhatsApp option saves send only the five owner-managed fields. The account,
  chat, owner contacts and remote/delegation fields are never sent from here.
- Lease rows are mapped field by field. Fencing tokens never reach the browser.

## Deliberately left out

- **Native V2 timer creation and schedule edits.** V2 runs timers handed off
  from V1 (pause, resume, stop and rollback work). Creating a new V2-native
  timer needs a V2 scheduling surface that does not exist yet. Until then, new
  timers for a migrated chat are created in V1 and handed off with the
  thread-timers tool.
- **Prompts and system instructions.** V1's web UI has no editor for them
  either: they live in the chat workspace (`AGENTS.md`) and the admin-only
  standing mission API.
- **Executor switching for V1-only chats.** Switching a V1 thread between
  Codex and Claude is a runtime handoff in V1. It stays in V1 until the chat
  moves.
- **Desktop grant editing, acquire, release and share.** Grants are
  admin-only in V1, and V1's UI never edits them per thread. Leases belong to
  the work that holds them, and releasing one needs its fencing token.
- **WhatsApp accounts, chat re-binding, detaching and owner contacts.** These
  are routing changes. They stay operator steps, as they are for migrated chats
  (adapter binding and relay).
- **Retire, restore and delete a chat, repo metadata, credit usage.** These are
  rare administrative actions that V1 keeps. "New WhatsApp chat" archives its
  own test chats with the ops tool.
