# Grant Application Workflow

Use this workflow when an owner asks Orkestr to prepare, maintain, or coordinate
funding applications. It is a documentation convention, not an implemented portal
integration, access grant, or authorization to submit an application.

Keep application records in their existing authorized private repositories or
private workspaces. This public repository contains generic guidance only.
Follow the [public/private boundary](public-private-repository-boundary.md),
existing repository instructions, and current owner authorization.

## Read in order

1. [Sections and Git history](grant-applications/sections-and-history.md): one
   canonical application directory, small section files, and reviewable changes.
2. [Portal verification](grant-applications/portal-verification.md): immutable
   content commits, evidence, hashes, and an honest distinction between drafts,
   portal-saved content, and submissions.
3. [Catalog and access](grant-applications/catalog-and-access.md): awareness
   across parent and application threads without copying confidential contents or
   widening access.

## Start each task

- Identify the application owner, canonical repository/path, program/cycle, and
  intended action. Read the application manifest and relevant source files.
- Assign one owner for portal editing at a time to prevent conflicting writes.
- Check the authorized private catalog for related applications before drafting.
  Read another application's contents only when access and purpose permit it.
- Compare current working files with the last portal-verified content commit.
  Treat later local edits as drafts until verified against the portal.
- Preserve user edits and existing access controls. If an owner, source, status,
  or permission cannot be verified, record that limitation rather than guessing.
- Preparation does not authorize upload, submission, signature, certification,
  expenditure, sharing, or communication with another agent. Obtain whatever
  authorization the actual action requires before taking it.

## Completion report

Report changed section paths and commit, portal checks actually performed,
remaining mismatches or unverified sections, and the catalog entry updated.
Distinguish committed, pushed, reviewed, portal-saved, and submitted. A clean Git
tree, successful tool call, or local test does not prove portal state.
