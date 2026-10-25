"""Read-only interactive intake-to-first-provider-send receipt measurements."""
import argparse
from contextlib import closing
from datetime import datetime
import json
import math
from pathlib import Path
import sqlite3


def send_time(ack):
    if (not isinstance(ack, dict) or ack.get("outcome") != "delivered" or
            not isinstance(ack.get("connectorMessageIds"), list) or not ack["connectorMessageIds"] or
            not all(isinstance(item, str) and item for item in ack["connectorMessageIds"]) or
            not isinstance(ack.get("deliveredAt"), str)):
        return None
    try:
        value = datetime.fromisoformat(ack["deliveredAt"].replace("Z", "+00:00"))
        return value.timestamp() if value.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def measure(path, after_ms):
    samples, silent, pending, invalid = [], 0, 0, 0
    with closing(sqlite3.connect(Path(path).resolve(strict=True).as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("BEGIN")
        inputs = db.execute("SELECT remote_id,json_extract(data,'$.queued_at'),json_extract(data,'$.settled.outcome') "
                            "FROM inputs WHERE json_extract(data,'$.origin') IS NULL "
                            "AND json_extract(data,'$.absorbed_into') IS NULL "
                            "AND json_extract(data,'$.queued_at')>=? ORDER BY rowid", (after_ms / 1000,)).fetchall()
        for remote, queued, outcome in inputs:
            receipts = []
            # Progress may be superseded before its late, genuine send ACK
            # arrives. Count that receipt too; supersession cannot unsend it.
            for seq, kind, raw in db.execute("SELECT seq,kind,ack FROM exports WHERE input_id=? AND "
                                             "source_key NOT LIKE 'stalled:%' AND source_key NOT LIKE 'heartbeat:%' "
                                             "AND source_key NOT LIKE 'continued:%' AND "
                                             "(outcome='delivered' OR (outcome='superseded' AND json_extract(ack,'$.outcome')='delivered'))", (remote,)):
                ack = json.loads(raw) if raw else None
                sent = send_time(ack)
                if sent is None or not isinstance(queued, (int, float)) or not math.isfinite(queued) or sent < queued:
                    invalid += 1
                    continue
                receipts.append((sent, seq, kind))
            if receipts:
                sent, seq, kind = min(receipts)
                samples.append({"input_id": remote, "first_export_sequence": seq, "first_kind": kind,
                                "latency_ms": round((sent - queued) * 1000)})
            elif outcome == "no_reply":
                silent += 1
            else:
                pending += 1
    ordered = sorted(row["latency_ms"] for row in samples)
    def percentile(fraction):
        return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)] if ordered else None
    return {"metric": "adapter_intake_to_first_provider_send_receipt", "after_ms": after_ms,
            "percentile_method": "nearest_rank", "eligible_inputs": len(inputs), "sample_n": len(samples),
            "p50_ms": percentile(0.5), "p95_ms": percentile(0.95), "silent_no_reply_inputs": silent,
            "inputs_without_send_receipt": pending, "invalid_timing_receipts": invalid,
            "small_sample": len(samples) < 20, "samples": samples}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--after-ms", type=int, required=True)
    args = parser.parse_args()
    if args.after_ms < 0:
        parser.error("after-ms must be nonnegative")
    print(json.dumps(measure(args.ledger, args.after_ms), indent=2))
