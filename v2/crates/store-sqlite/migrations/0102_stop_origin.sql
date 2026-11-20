-- Who asked for a Stop. A superseded Deep run's host result goes to the run
-- that succeeded it, unless the owner himself stopped the run. request_revision
-- alone cannot tell: the release train and operators stop through the same
-- guarded route as the owner. From now on the cancellation write records it
-- (production_runtime/cancellation.rs, stop_origin); existing rows get the same
-- rule here. Unknown is never the owner:
--   internal  an unguarded Stop (deadline, budget, shutdown): no request_revision
--   release   the release train: release-<head>-<run> (also release-db...), forced-release...
--   operator  an operator Stop: lead-... or lead:...
--   owner     the owner's web UI Stop button: its crypto.randomUUID() key
--   other     any other guarded key
ALTER TABLE production_cancellations ADD COLUMN stop_origin TEXT
 CHECK(stop_origin IS NULL OR stop_origin IN ('owner','release','operator','internal','other'));
UPDATE production_cancellations SET stop_origin=CASE
 WHEN request_revision IS NULL THEN 'internal'
 WHEN request_key GLOB 'release-*' OR request_key GLOB 'forced-release*' THEN 'release'
 WHEN request_key GLOB 'lead-*' OR request_key GLOB 'lead:*' THEN 'operator'
 WHEN length(request_key)=36 AND request_key GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' THEN 'owner'
 ELSE 'other' END;
