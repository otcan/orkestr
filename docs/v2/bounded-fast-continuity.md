# Bounded Fast native continuity

The Codex Fast companion in an execution window starts a fresh native session
when the window opens and keeps that accepted native child warm for the
window's later owner inputs. It never resumes accumulated Fast native history
from an earlier window. Deep and Worker identities, settings and native
continuity use their existing paths. The isolated non-window factory and Claude
Fast are unchanged.

Same-window reuse: after genuine acceptance the scheduler keeps the original
Fast child alive while idle and asks Core (`bounded_fast_reusable`, read-only)
whether the next source may continue on it. Core allows it only when the
binding was created by this exact window incarnation (one window belongs to one
conversation), every earlier run on it was accepted and was not a timer input,
the next source is not a timer input, and fewer than eight turns used it. Fast
admission enforces the same rule, so a refused continuation can never dispatch.
A continued turn receives the exact current input without the digest, because
the warm native child already holds the window's earlier turns. This keeps the
warm start (about 0.15 s instead of 3-4 s for a fresh Codex session) and lets a
chat-rules line be read once per window instead of once per message.

Rotation: when reuse is refused, or after Stop, the scheduler reaps the
original Fast native child. It holds that exact non-clone cleanup witness while
idle. A new eligible source then permits the dedicated Fast metadata issuer to
retire the old binding and create a fresh Starting binding in one transaction.
A genuine Stopped predecessor can use the same boundary. A proposal, interrupt
ACK, unresolved run, unconfirmed native setup or stale binding cannot rotate.
The old binding and native ID remain reserved history. No caller can supply a
native ID.

The previous terminal witness remains held through fresh setup until a new
consumed dispatch attaches to its original child. Shutdown or window expiry
before dispatch closes setup by trusted broker EOF, waits the original child and
requires its normal exit73/ECHILD evidence. This metadata-only proof has no
synthetic run identity and stays retained through window close. Unused setup is
fenced without admitting or releasing input. Protocol/setup uncertainty keeps
the original quarantine and reconciliation fences; it never certifies cleanup.

A successor window also starts Fast fresh, after the ordinary closed-window
retirement and exact readiness lineage checks. Workspace authority is copied
only from that proved association. Setup-only failed openings retire their unused
bounded Fast bindings during the existing manager-proven reconciliation commit;
they never reuse an uncertain setup or replay its input.

Migration 77 records Fast lineage and the exact private digest used by a run.
The digest is generated without a model call from canonical conversation events:
at most eight recent owner inputs or owner-accepted Fast/Deep proposal excerpts,
at most 512 UTF-8 bytes per excerpt, and at most 8192 bytes including framing and
JSON escaping. It excludes timer instructions, held inputs, unaccepted proposals
and events at or after the current input's journal sequence. Removed proposal
payloads are excluded. The frozen digest remains historical dispatch evidence.

The digest explicitly labels entries as incomplete quoted history, gives no tool
or replay authority and makes no external-delivery claim. The current immutable
input follows unchanged. Its message/event IDs, request key, source order and
owner-wide Fast deduplication stay unchanged. The digest receipt and one-use
dispatch consumption commit together, so uncertainty never mints a replacement
dispatch. Timer Fast turns still receive only the fixed no-action note.

Fresh setup per window (and after the eight-turn cap) removes compaction caused
by accumulated Fast turns. A single current turn still obeys its ordinary
execution budget and native provider limits; this does not disable provider
safety or context checks.
