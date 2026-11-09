# Temporary SQLite security compatibility patch

This is published `sqlx-sqlite` 0.8.6 from
[crates.io](https://crates.io/crates/sqlx-sqlite/0.8.6), archive SHA-256
`c2d12fe70b2c1b4401038055f90f151b78208de1f9f89a7dbfd41587a10c3eea`.
Its published VCS record identifies SQLx commit
`bab1b022bd56a64f9a08b46b36b97c5cff19d77e`, path `sqlx-sqlite`.
Both upstream MIT and Apache-2.0 licenses are retained.

All published files are unchanged except the normalized `Cargo.toml` dependency
on `libsqlite3-sys`: `0.30.1` becomes exactly `=0.39.1`. This note is additional.
Rust source and `Cargo.toml.orig` remain byte-for-byte intact. The workspace
`[patch.crates-io]` selects this driver. The lock selects `libsqlite3-sys` 0.39.1,
which bundles SQLite 3.54.1.

[RUSTSEC-2026-0459](https://github.com/RustSec/advisory-db/blob/main/crates/libsqlite3-sys/RUSTSEC-2026-0459.md)
reports information disclosure when a database and sibling WAL have inconsistent
page sizes. The [SQLite fix](https://github.com/sqlite/sqlite/commit/e5bf119821f25be1d7f10ef0a2edbe175289166e)
initializes the unread page tail. Fixed bundled crates start at 0.39.0.
No advisory is suppressed or excepted.

The [published crate index](https://index.crates.io/sq/lx/sqlx-sqlite) records
that, at adoption, released SQLx 0.8.6 requires `libsqlite3-sys ^0.30.1`; even released
0.9.0's `<0.38.0` bound excludes the fix. Upstream main permits `<0.40.0`, but
adopting its entire unreleased workspace would broaden this repair. Remove this
temporary patch when a maintained released SQLx driver supports fixed bundled
SQLite, after the same Store/migration, WAL and server compatibility checks pass.
Do not reintroduce an affected bundled version or rely on unverified system SQLite.
