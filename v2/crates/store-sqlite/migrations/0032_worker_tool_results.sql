-- Native correlation is input. Only private, current-authenticated handles can
-- consume launch or result authority; historical rows never reissue either.
CREATE TABLE worker_tool_results (
 delegation_id TEXT PRIMARY KEY REFERENCES worker_tool_delegations(id),
 parent_run_id TEXT NOT NULL REFERENCES production_runs(id),
 request_kind TEXT NOT NULL CHECK(request_kind IN ('text','integer')),
 request_id TEXT NOT NULL CHECK(length(CAST(request_id AS BLOB)) BETWEEN 1 AND 128),
 call_id TEXT NOT NULL CHECK(length(CAST(call_id AS BLOB)) BETWEEN 1 AND 128),
 native_thread TEXT NOT NULL CHECK(length(CAST(native_thread AS BLOB)) BETWEEN 1 AND 512),
 native_turn TEXT NOT NULL CHECK(length(CAST(native_turn AS BLOB)) BETWEEN 1 AND 512),
 call_digest TEXT NOT NULL CHECK(length(call_digest)=64 AND call_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('bound','prepared','delivery_unknown','delivered')),
 output_digest TEXT,
 response_text TEXT,
 response_digest TEXT,
 success INTEGER CHECK(success IS NULL OR success IN (0,1)),
 grant_hash TEXT,
 delivery_hash TEXT,
 written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes BETWEEN 0 AND 65536),
 CHECK(output_digest IS NULL OR (length(output_digest)=64 AND output_digest NOT GLOB '*[^0-9a-f]*')),
 CHECK(response_digest IS NULL OR (length(response_digest)=64 AND response_digest NOT GLOB '*[^0-9a-f]*')),
 CHECK(response_text IS NULL OR length(CAST(response_text AS BLOB))<=8192),
 CHECK((state='bound' AND output_digest IS NULL AND response_text IS NULL AND response_digest IS NULL AND success IS NULL AND grant_hash IS NULL AND delivery_hash IS NULL)
    OR (state='prepared' AND output_digest IS NOT NULL AND response_text IS NOT NULL AND response_digest IS NOT NULL AND success IS NOT NULL AND grant_hash IS NOT NULL AND delivery_hash IS NULL)
    OR (state IN ('delivery_unknown','delivered') AND output_digest IS NOT NULL AND response_text IS NOT NULL AND response_digest IS NOT NULL AND success IS NOT NULL AND grant_hash IS NULL AND delivery_hash IS NOT NULL)),
 UNIQUE(parent_run_id,native_thread,native_turn,request_kind,request_id),
 UNIQUE(parent_run_id,native_thread,native_turn,call_id)
);
