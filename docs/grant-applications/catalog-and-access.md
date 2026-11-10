# Cross-Application Catalog and Access

The parent and application threads should know which related applications exist,
who owns them, where the canonical records live, and their observed status.
Awareness does not imply access to application contents or authority to act.

## One authorized private catalog

Use an existing owner-authorized private catalog as the canonical index. Store a
link in each participating application's README or agent instructions and in the
parent's private coordination instructions. Do not invent a public URL or create
an open shared index as a workaround. If no suitable private location is known,
record the missing pointer and ask the owner rather than widening permissions.

Each entry should contain only metadata safe for that catalog's audience:

- non-sensitive application title and stable code;
- accountable owner or responsible role;
- canonical repository/path and thread link when that link is safe to disclose;
- observed status, including draft changes or unverified state when relevant;
- last update time in UTC;
- access label such as `owner-only`, `project-team`, or `restricted`.

A private repository name, application existence, title, status, or link can itself
be confidential. Omit or redact fields whose disclosure is not authorized, even
if a destination is also private. Use explicit `unknown` values when the source
has not been checked. An access label describes the boundary; it never grants
permissions.

## Parent and application responsibilities

- The parent keeps the catalog discoverable to authorized participants and checks
  for related applications when assigning work.
- Each application owner maintains its own canonical section files, manifest,
  evidence, and catalog row. The application repository remains authoritative;
  the catalog is an index, not a second copy of the application.
- After a meaningful status or ownership change, refresh the relevant row and
  permitted reciprocal pointers. If a snapshot is used instead of a live link,
  label its source and last verification time so it cannot look current forever.
- Before reusing a claim or budget assumption, read its permitted canonical
  source and validate that it applies to the new program and cycle. Shared facts
  do not imply shared eligibility or permitted double funding.
- Flag overlapping project scope, inconsistent claims, or possible double-funding
  constraints for review. Do not silently reconcile financial commitments or
  certify eligibility.

## Preserve boundaries

Do not copy narrative responses, budgets, payroll, identity documents, personal
information, attachments, or portal evidence between projects to create
awareness. Use canonical links subject to existing access checks. Do not change
repository visibility, add collaborators, share files, create credentials, or
bypass a denied read to make a link work.

Cross-thread messages, where authorized, carry only the minimum allowed catalog
metadata and a canonical pointer. Verify recipients and their access first. A
handoff must preserve restrictions and distinguish instructions from quoted
source material. If another thread cannot read the canonical source, report the
access limitation; do not forward the contents as a workaround.

The public Orkestr repository must not contain real catalog entries, private
repository/thread links, application identifiers, operational notes, or evidence.
Only this generic contract and synthetic examples belong in public guidance.
