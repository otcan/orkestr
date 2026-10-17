# Personal Agent home shell (OP-18)

This shell adds a home view to the existing Orkestr web app; it does not replace
threads, thread workers, task agents, or the Agent Job store. The view is
available only when the server reports the `personalAgent` flag as enabled.
The existing Conversations navigation and thread routes remain intact.

## Desktop wireframe

```text
┌ Orkestr   Home   Conversations   Desktops   System   Timers ─────────────┐
│ Personal Agent · one place to continue a conversation and inspect work  │
├───────────────────────────────────────────┬────────────────────────────┤
│ PRIMARY CONVERSATION                       │ GROUNDED BRIEFING          │
│ Existing thread messages + composer        │ Verified facts only        │
│ (or create/open an existing conversation)  │ Explicit loading/offline/  │
│                                           │ stale/unavailable state   │
├────────────────────┬──────────────────────┴────────────────────────────┤
│ ACTIVE WORK        │ NEEDS ATTENTION         │ RECENT RESULTS            │
│ Evidence-backed    │ Persisted blockers/     │ Verified outcomes only    │
│ projection or state│ approvals or state      │ or state                  │
├────────────────────────────────────────────────────────────────────────┤
│ EXISTING CONVERSATIONS · one-click links to legacy thread routes        │
└────────────────────────────────────────────────────────────────────────┘
```

## Narrow-screen wireframe

```text
Orkestr · Home / Conversations
Grounded briefing + explicit data state
Primary conversation (messages and composer)
Active work
Needs attention
Recent results
Existing conversations
```

## Data and state rules

- The primary conversation reuses the selected existing thread, message list,
  and composer. A new conversation uses the existing thread-creation flow.
- Existing thread summaries power the legacy-conversation links. No project or
  task entities are inferred from chat text.
- Until OP-06 supplies persisted projections, active work, attention, recent
  results, and briefing display an explicit unavailable/empty state. Product
  code contains no sample tasks, fabricated counts, or synthetic progress.
- Loading, offline, stale, and unavailable labels are distinct. Stale content
  must remain visibly marked with its last verified time once real data exists.
- The capability endpoint is used only for the `personalAgent` gate. Failure
  or an unrecognized response keeps the legacy app view available.
- This is an application-level single-user experience, not an isolation
  boundary for root-capable runtimes.

## Visual and accessibility behavior

The shell uses the existing `--ui-*` surface, border, text, muted, accent, and
focus tokens. At narrow widths, the grid collapses to one column without
reordering the primary conversation below status cards. Sections use heading
hierarchy and labelled landmarks; status changes use a polite live region;
thread actions are native buttons with visible focus; reduced-motion behavior
is inherited from the app shell.
