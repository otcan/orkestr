import assert from 'node:assert/strict';
import test from 'node:test';
import {authenticationFailureEvidence} from '../packages/connectors/src/whatsapp-auth-failure-evidence.js';

test('a failed preserving restore retains device registration without claiming logout', () => {
  const result = authenticationFailureEvidence({preservingProbe:true, at:'2026-01-02T00:00:00Z'});
  assert.equal(result.verifiedLogoutAt,null);
  assert.equal(result.clearPairedRegistration,false);
  assert.equal(result.failureKind,'saved_session_restore_failed');
});

test('a preserving probe cannot clear independently recorded logout evidence', () => {
  const previous={verifiedLogoutAt:'2026-01-01T00:00:00Z'};
  const result=authenticationFailureEvidence({preservingProbe:true,previous,at:'2026-01-02T00:00:00Z'});
  assert.equal(result.verifiedLogoutAt,previous.verifiedLogoutAt);
  assert.equal(result.clearPairedRegistration,false);
});

test('normal authentication failure retains the existing lifecycle policy', () => {
  const at='2026-01-02T00:00:00Z';
  const result=authenticationFailureEvidence({at});
  assert.equal(result.verifiedLogoutAt,at);
  assert.equal(result.clearPairedRegistration,true);
  assert.equal(result.failureKind,'authentication_failed');
});
