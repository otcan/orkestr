"""Indexes for the ledger's hot filters (ORK-772).

An input row stays in its ledger after it is completed and settled (only its
text is pruned), and the filters a pass uses are JSON fields. Without an index
every pass read and parsed every row ever written: about a dozen full scans
per pass, which for a chat with a long history meant tens of MB per pass and
about 2 CPU cores for the whole adapter.

The partial indexes hold only the rows a pass looks for: inputs that are not
completed (the run queue) and inputs that are not settled (V1's listing). They
are created idempotently in the ledger's start transaction. SQLite maintains
them on every write, so an adapter without this module (a rollback) reads and
writes the same rows; it only scans again.
"""

# The run queue: every input whose phase is not `completed`.
OPEN_PHASE = "json_extract(data,'$.phase') != 'completed'"
# Rowids of the run queue, read from the partial index alone. SQLite does not
# pick a partial index for `WHERE <open> ORDER BY rowid LIMIT n` by itself (a
# rowid-ordered table scan that may stop early looks cheaper to the planner),
# but it always does for this subquery. Same rows, same order.
OPEN_ROWS = "rowid IN (SELECT rowid FROM inputs WHERE %s)" % OPEN_PHASE

INDEXES = (
    ("ledger_inputs_open", "inputs(json_extract(data,'$.phase')) WHERE " + OPEN_PHASE),
    ("ledger_inputs_unsettled", "inputs(json_extract(data,'$.settled')) WHERE json_extract(data,'$.settled') IS NULL"),
    # V1's listing reads each unsettled input's unreported exports by input.
    ("ledger_exports_input", "exports(input_id, seq)"),
    ("ledger_exports_unreported", "exports(seq) WHERE outcome IS NULL OR outcome='uncertain'"),
)


def initialize(db):
    """Create the indexes that are missing; inside the caller's transaction."""
    for name, definition in INDEXES:
        db.execute("CREATE INDEX IF NOT EXISTS %s ON %s" % (name, definition))
