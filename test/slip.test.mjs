import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterResponse, nextAttempt, slipSignature } from '../lib/slip.mjs';

let n = 0;
const newId = () => `id-${++n}`;
const items = [{ selectionId: 'a', odds: '2.10' }];

test('a retry of the same slip after a timeout reuses the idempotency key', () => {
  const sig = slipSignature(items, '1000', false);
  const first = nextAttempt(null, sig, newId);
  const kept = afterResponse(first, { ok: false, status: 0 });
  assert.equal(nextAttempt(kept, sig, newId).requestId, first.requestId);
  const kept502 = afterResponse(first, { ok: false, status: 502 });
  assert.equal(nextAttempt(kept502, sig, newId).requestId, first.requestId);
});

test('a changed slip or a definite answer gets a new key', () => {
  const sig = slipSignature(items, '1000', false);
  const first = nextAttempt(null, sig, newId);
  assert.notEqual(nextAttempt(first, slipSignature(items, '2000', false), newId).requestId, first.requestId);
  assert.notEqual(nextAttempt(first, slipSignature([{ selectionId: 'a', odds: '2.20' }], '1000', false), newId).requestId, first.requestId);
  assert.equal(afterResponse(first, { ok: true, status: 201 }), null);
  assert.equal(afterResponse(first, { ok: false, status: 403 }), null);
});
