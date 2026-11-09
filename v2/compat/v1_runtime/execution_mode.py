"""Adapter execution mode; old presentation settings cannot enable companions."""
import json
import time

MAX_MIGRATION_EXPORTS = 512


def single(worker, data=None):
    # An input first admitted in single mode never acquires another role later.
    return ((data or {}).get("execution_mode") == "single" or
            not getattr(worker, "legacy_companions", False))


def freeze(worker, data):
    """Freeze new input handling before any attachment/message mutation."""
    if single(worker, data) and data.get("execution_mode") != "single":
        data["execution_mode"] = "single"
        worker.ledger.save(data)
    elif "intake" not in data and "execution_mode" not in data:
        data["execution_mode"] = "single" if single(worker) else "legacy_companions"
        worker.ledger.save(data)


def retire_exports(ledger):
    """Withdraw explicitly linked pending companion replies, never invent ACKs.

    Uses the existing superseded transport outcome: a late physical receipt is
    still recorded. It cannot recall a send already materialized by V1, which
    must be reconciled during deployment drain. No Core run is accepted here.
    """
    with ledger.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        rows = db.execute("SELECT p.data,e.input_id,e.export_id,e.message FROM inputs p JOIN exports e "
                          "ON e.export_id=json_extract(p.data,'$.first_response.export_id') "
                          "WHERE e.outcome IS NULL OR e.outcome='uncertain' LIMIT ?",
                          (MAX_MIGRATION_EXPORTS + 1,)).fetchall()
        if len(rows) > MAX_MIGRATION_EXPORTS:
            raise ValueError("companion_export_migration_capacity")
        for raw, exported_input, export_id, message_raw in rows:
            data, message = json.loads(raw), json.loads(message_raw)
            first = data.get("first_response") or {}
            if (message.get("firstResponse") is not True or message.get("layer") != "fast"
                    or message.get("sourceInputId") != data["remote_id"]
                    or first.get("export_id") != export_id):
                continue
            if exported_input != data["remote_id"]:
                row = db.execute("SELECT data FROM inputs WHERE remote_id=?", (exported_input,)).fetchone()
                pseudo = json.loads(row[0]) if row else None
                if (not pseudo or first.get("remote_id") != exported_input or
                        (pseudo.get("first_response_for") or {}).get("input_id") != data["remote_id"]):
                    continue
            else:
                pseudo = None
            db.execute("UPDATE exports SET outcome='superseded' WHERE export_id=?", (export_id,))
            if pseudo is not None:
                ledger._settle(db, pseudo, "superseded")
            first.update(superseded_at=time.time(), delivery_blocker="single_agent_retired")
            data["execution_mode"] = "single"
            ledger.save(data, db)
