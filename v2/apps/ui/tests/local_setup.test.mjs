import test from 'node:test';
import assert from 'node:assert/strict';
import {takeLocalSetup, HANDOFF} from '../src/local_setup.mjs';
const token = 'A'.repeat(43);
test('a desktop handoff is read once and removed from the page', () => {
    const scope = {[HANDOFF]: {bootstrap: token}};
    assert.equal(takeLocalSetup(scope), token);
    assert.equal(HANDOFF in scope, false);
    assert.equal(takeLocalSetup(scope), null);
});
test('ordinary browsers and malformed handoffs keep the manual setup form', () => {
    for (const value of [undefined, null, {}, {bootstrap: 42}, {bootstrap: 'short'}, {bootstrap: 'x'.repeat(257)}, {bootstrap: token + ' '}, {bootstrap: token + '"'}]) {
        assert.equal(takeLocalSetup({[HANDOFF]: value}), null);
    }
    assert.equal(takeLocalSetup({}), null);
});
