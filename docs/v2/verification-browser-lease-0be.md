# Independent browser lease source review

Reviewed exact `0be4915a4750b5c48b787a88f31f066d820c4dc3`, limited to its
synthetic guard test and current-authority document. No bounded source blocker
was found. This is not live browser authority or manager integration acceptance.

The six cases import the existing guard and persisted store, create isolated
synthetic homes, and clean them through the test lifecycle. Independent field
mutations reset to the valid baseline. They check current identity, owner,
thread, exclusive mode, expiry, heartbeat, replacement identity/version/token,
and refusal after a persisted release. The retained successful object remains
unchanged while a subsequent guard call rereads storage and refuses it.

The actual guard remains conditional on enforce mode and has a separate
explicit break-glass path. Those policy decisions are outside these tests.
Snapshot writes do not exercise acquisition, heartbeat or release APIs. The
capability broker's consumption and subsequent lease read are not serialized
with a browser action. An already returned snapshot or connection cannot be
credited as continuing authority; concurrent revocation and action fencing remain
unresolved manager-side dependencies.

Independent validation was source inspection of the exact two-file delta and
its existing guard/store dependencies, plus Node syntax checking of the exact
test source. No browser, API or guard-test execution was performed in this
review. The six passing guard tests remain author evidence: their disclosed
external dependency resolver was required after a missing transitive package;
the ordinary dependency-complete command was not independently reproduced.

The combined stopped/Worker composition remains a separate pending gate. This
review grants no process, provider, channel retirement or live-authority credit.
