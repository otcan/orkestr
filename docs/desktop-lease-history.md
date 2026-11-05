# Bounded desktop lease history

Operators may enable writer-path retention with
`ORKESTR_DESKTOP_LEASE_HISTORY_ARCHIVE_DIR`, an absolute private directory owned
by the service account. Optional `ORKESTR_DESKTOP_LEASE_HISTORY_KEEP_RELEASED`
and `ORKESTR_DESKTOP_LEASE_HISTORY_THRESHOLD` default to 500 and 1800.
The feature is disabled when the archive directory is unset.

Every lease mutation checks the policy while holding the existing persistent
writer lock. At the threshold, it archives the complete pre-mutation state to a
content-addressed JSON file, fsyncs and verifies it, then retains every active
lease, all immutable adopted-cohort records, and the newest released records.
Fencing counters, lock identity, adopted payloads and retained rows do not
change. Each archive is mode 0400 in a mode 0700 directory; unsafe permissions,
links, content collisions or I/O failures refuse the mutation. Archive storage
must be included in operational backup and capacity monitoring.

This admission-path check avoids depending on a periodic cleanup interval.
It does not discard active authority to fit a budget. An unusually large
adopted cohort or active population can still exceed the existing state limits
and requires explicit operator diagnosis; no empty-state fallback is used.

Owner viewing uses the separate `POST /api/desktops/:slug/share-if-absent`
endpoint. It borrows a same-thread lease without changing its fence or expiry,
or releases only the short lease it created for preparing the view. It verifies
the existing desktop's visual readiness without starting or restarting it.
The share is created atomically only if its lineage has no live link, preserving
existing viewing sessions. A normal viewing challenge remains required.
