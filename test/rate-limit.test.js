import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../server/rate-limit.js';

const response = () => {
  const state = { status: null, headers: {}, body: null };
  const api = {
    state,
    status: (value) => { state.status = value; return api; },
    set: (name, value) => { state.headers[name] = value; return api; },
    json: (value) => { state.body = value; return api; },
  };
  return api;
};

test('rate limiter returns 429, Retry-After, and emits the blocking context', () => {
  const blocked = [];
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    key: (req) => req.user.id,
    message: 'Too many protected writes.',
    onBlocked: (_req, context) => blocked.push(context),
  });
  const req = { ip: '127.0.0.1', user: { id: 42 } };
  let nextCalls = 0;

  limiter(req, response(), () => { nextCalls += 1; });
  const denied = response();
  limiter(req, denied, () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(denied.state.status, 429);
  assert.match(denied.state.headers['Retry-After'], /^\d+$/);
  assert.deepEqual(denied.state.body, { error: 'Too many protected writes.', retryAfter: Number(denied.state.headers['Retry-After']) });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].identity, '42');
});
