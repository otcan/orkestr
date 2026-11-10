# Synthetic migration audit cases

Run from repository root:

```sh
python3 v2/fixtures/migration-audit/validate.py
```

`cases.json` contains synthetic source excerpts, not complete legacy rows or target
requests. Camel-case task/run objects follow `taskFromRow` / `rowToRun`; message
and effect excerpts follow source SQLite column names. `expected`, `audit_version`,
`source_instance`, `dispatch_allowed` and artifact `fixture_relative_path` are audit
harness metadata only. The project reference is intentionally unresolved by any
project-to-conversation rule: no such target assignment is proposed.

Two same-name threads stay distinct. Message IDs repeat across threads; positions,
cursors and timestamps deliberately differ. Task/run states needing unsupported
mapping stay explicit. Cancelled and unknown effect examples are inert historical
cases, not claims that either should be recreated as an executable effect row.
Run output/ref examples do not certify task completion. Resource metadata confers
no grant. The single artifact has harmless bytes and a checked SHA-256.

The standard-library validator reads only adjacent fixture/artifact files. It
checks graph/reference/order invariants, gaps, exclusions and hashes, then mutates
in-memory copies to reject 13 bad cases. Digest comparisons illustrate the proposed
repeat/conflict rule without creating an importer or durable mapping store. It
writes no files and calls no product code, providers or connectors. It does not
validate arbitrary legacy exports, enforce a real privacy scanner, or prove Rust
contract compatibility. See the field audit in `docs/v2/migration-audit/README.md`.
