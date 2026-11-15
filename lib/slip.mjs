/**
 * Idempotency key for placing the current slip. A retry of the same slip after no definite answer
 * (network error, timeout, 5xx) reuses the key, so the platform replays the first request instead of
 * placing a second bet. A changed slip, or a definite answer, starts a new key.
 */
export const slipSignature = (items, stake, acca) =>
  JSON.stringify([items.map((i) => [i.selectionId, i.odds]), stake, Boolean(acca)]);

export const nextAttempt = (previous, signature, newId) =>
  previous && previous.signature === signature ? previous : { signature, requestId: newId() };

/** After a response: keep the attempt only when the outcome is unknown. */
export const afterResponse = (attempt, res) => (res.ok || (res.status >= 400 && res.status < 500) ? null : attempt);
