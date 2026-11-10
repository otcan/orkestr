# Application Sections and Git History

Keep one canonical directory for each application in the authorized private
repository. Adapt an existing layout rather than creating a competing source.
A generic starting layout is:

```text
applications/<application-code>/
  README.md
  manifest.json
  sections/
    01-project-summary.md
    02-need-and-objectives.md
    03-method-and-workplan.md
    04-team-and-capability.md
    05-impact.md
    06-budget-narrative.md
  evidence/README.md
```

The example section names are placeholders. Use the actual portal's sections,
question identifiers, order, language, and word/character limits. Small,
purpose-specific files are the source; a compiled export is a derived artifact,
not a second editable source. Do not replace section files with one giant
application document.

## Section content

Each Markdown file records its portal section/question identifier, exact prompt,
limits, response text, and unresolved questions or evidence references. Mark the
response boundaries explicitly so headings and drafting notes cannot accidentally
be pasted into a portal. Keep factual claims sourced and distinguish verified
facts, assumptions, and owner decisions. Never invent missing details.

Payroll, identity documents, private budgets, and other restricted attachments
stay in their authorized protected location. Record only permitted references;
do not copy them into another repository for convenience.

## Versioning

- Use Git commits and diffs as the version history. Avoid `final-v2`, dated copies,
  and duplicate application folders as a substitute for Git history.
- Commit coherent, scoped changes with a useful message and explicit paths.
  Review the full diff before committing or pushing; do not include unrelated
  user edits, credentials, or restricted attachments.
- Follow existing branch/review rules and owner authorization. Do not merge,
  force-push, rewrite published history, or deploy as a side effect.
- Pin a full commit SHA for portal verification. The manifest's content commit
  must already exist; commit the verification record afterward to avoid a
  circular self-reference.
- Preserve earlier verification records in Git. A later draft changes the draft,
  not the historical claim about what was observed in the portal.

## Application README

Record the program/cycle, accountable owner, canonical section order, current
workflow state, blockers, and links to the local manifest and authorized private
catalog. Clearly label unknown or stale details. Link to another application's
canonical location instead of copying its narrative or numbers.
