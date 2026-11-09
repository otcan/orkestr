# Portal Verification and Drafts

A local draft, a saved portal draft, and a submitted application are different
states. Record them independently. Never call local files portal-verified merely
because they were generated, committed, uploaded, or used in a past application.

## Manifest contract

Use the existing manifest format when possible. The portable JSON convention is:

- `schema_version`: `1`. Record `application_id`, `grantor`, `program`, `call`,
  `owner`, `canonical_url`, `deadline`, and `updated_at`; unverified call, owner,
  canonical URL, and deadline values remain `null`.
- `content_state`: `missing`, `incomplete`, or `complete`, measured against the
  actual `required_portal_fields` inventory, not confidence in the prose.
- `sources`: records with `id`, `kind`, safe `reference`, `captured_at`, and
  optional `source_saved_at` and `sha256`. Source kinds are `portal_readback`,
  `official_export`, `thread_report`, and `local_document`. A thread report
  cannot certify portal content.
- `sections`: ordered records with `id`, `path`, `portal_fields`, `source_refs`,
  and `last_portal_verification`, initially `null`. A verified section records
  `commit`, `sha256`, `verified_at`, and `evidence_ref`.
- `portal_snapshot`: initially `null`; otherwise `commit`, `verified_at`,
  `scope` (`partial` or `complete`), `section_ids`, and `evidence_refs`. This is
  the latest verification pass; individual sections can retain earlier records.
- `submission`: independent `status` (`unknown`, `unsubmitted`, or `submitted`),
  with `submitted_at`, `receipt_ref`, and `content_commit` when applicable.
- `backup`: independent `status` (`local_only`, `unverified`, or
  `remote_verified`), with `remote_commit`, `verified_at`, and `reference` for a
  verified remote backup. A push attempt is not remote verification.
- `blockers`: missing inputs, mismatches, or actions in plain language.

Use UTC or an explicit UTC offset for timestamps. Capture time is not an invented
portal save time. Relative section paths must remain within the application
directory. Do not use one ambiguous `done` status for these separate dimensions.

A section's verification `sha256` hashes the exact UTF-8 Markdown bytes, including
line endings, at the full existing `commit` SHA. Record extraction, rendering,
and normalization in the source record. Compare response text only, excluding
headings, prompts, and drafting notes. Do not trim or collapse whitespace to hide
a mismatch. A hash proves byte identity, not semantic fidelity or portal state.

Check every field assigned to a section before verifying that section. Split the
section if only some fields can be checked. For `scope: complete`, the official
required-field inventory must be complete, every field mapped, and every section
included with verification at the same content commit and time. A partial or
redacted recovery must remain explicitly partial or redacted.

Keep earlier section verification records unchanged after local edits. A match
with the historical snapshot does not promise nobody has edited the portal since
then; show its age and recheck before consequential actions.

## Verification sequence

1. Read the manifest and compare working files with the previous verified commit.
   Preserve any later local edits; never silently overwrite them from the portal.
2. Prepare the exact section content in a clean, scoped content commit. Validate
   mandatory fields, limits, attachment requirements, dates, and numerical
   consistency against the actual program requirements.
3. Perform only authorized portal actions using the existing managed access.
   After a save, reopen/reload the relevant fields or obtain an authoritative
   export. Compare every claimed verified section, including select options and
   attachments when they are part of the claim. A click or toast alone is not
   enough.
4. Store the evidence in the approved private location. Capture observation time,
   scope, method, and hashes. Do not retain credentials, session URLs, or tokens
   in evidence or manifests. If evidence cannot be retained, state what was
   observed and the resulting audit limitation.
5. Update the manifest in a separate commit only for the scope actually verified.
   A partial check must list checked and unchecked sections and must not be
   promoted to full verification. Preserve earlier section records and Git
   history when a newer partial attempt or mismatch occurs; do not present a
   partial pass as complete.
6. Update the authorized catalog's minimal status and timestamp. Make draft
   changes since the verified content commit visible to the next worker.

## Failure and submission boundaries

- If a save, upload, or submit has an uncertain outcome, inspect current portal
  state before retrying. Do not duplicate submissions or payments.
- If the portal differs from the pinned source, record the mismatch and reconcile
  with the owner when intent is unclear. Do not relabel either version verified.
- Submission, signatures, certifications, commitments, and new sharing require
  their applicable authorization. The workflow itself grants none.
- Mark submitted only after authoritative submission evidence, such as an
  official receipt, is observed. Keep its timestamp and restricted evidence
  reference separate from draft verification.
