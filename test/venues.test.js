import assert from 'node:assert/strict';
import test from 'node:test';
import { Queries } from '../server/queries.js';

test('public venue listing selects active venues without an anonymous owner parameter', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 7, isActive: 1 }]];
    },
  });

  const venues = await queries.venuesForViewer();

  assert.equal(venues.length, 1);
  assert.match(calls[0].sql, /COALESCE\(v\.is_active, TRUE\) = TRUE/);
  assert.deepEqual(calls[0].parameters, []);
});

test('a customer sees active venues and their own inactive venues', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(42, 'customer');

  assert.match(calls[0].sql, /COALESCE\(v\.is_active, TRUE\) = TRUE OR v\.owner_user_id = \?/);
  assert.deepEqual(calls[0].parameters, [42]);
});

test('a venue owner can limit the listing to venues they manage', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(42, 'venue_owner', { managedOnly: true });

  assert.match(calls[0].sql, /WHERE v\.owner_user_id = \? ORDER BY/);
  assert.deepEqual(calls[0].parameters, [42]);
});

test('a manager can see every venue, including inactive and managed listings', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[]];
    },
  });

  await queries.venuesForViewer(9, 'manager');
  await queries.venuesForViewer(9, 'manager', { managedOnly: true });

  assert.match(calls[0].sql, /WHERE TRUE ORDER BY/);
  assert.match(calls[1].sql, /WHERE TRUE ORDER BY/);
  assert.deepEqual(calls[0].parameters, []);
  assert.deepEqual(calls[1].parameters, []);
});
