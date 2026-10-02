import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../server/database.js';

test('fresh startup creates the complete schema without upgrades or data backfills', async () => {
  const statements = [];
  const database = Object.create(Database.prototype);
  database.pool = { execute: async (sql) => { statements.push(sql); return [[]]; } };
  await Promise.all([database.initialize(), database.initialize()]);
  const schema = new Map();
  for (const sql of statements) {
    assert.doesNotMatch(sql, /ALTER TABLE|information_schema|SHOW COLUMNS|INSERT[^;]+SELECT/is);
    const table = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
    if (!table) continue;
    assert.equal(schema.has(table), false, `${table} created twice`);
    for (const [, dependency] of sql.matchAll(/REFERENCES (\w+)\(/g)) {
      assert.ok(dependency === table || schema.has(dependency), `${table} references ${dependency} before creation`);
    }
    schema.set(table, sql);
  }
  const required = {
    events: ['organizer_organization_id', 'brand_name', 'logo_image', 'food_options'],
    venues: ['logo_image'], organizations: ['default_billing_profile_id'], payment_accounts: ['details_submitted'],
    venue_bookings: ['invoice_generation_status', 'invoice_generation_error'],
    ticket_orders: ['checkout_session_id', 'checkout_key', 'checkout_expires_at', 'test_mode'],
    platform_subscriptions: ['trial_end'], subscription_checkouts: ['feature'],
    event_payment_settings: ['seller_capacity', 'refund_policy_snapshot'],
    invoices: ['context_type', 'context_id', 'invoice_series_id', 'paid_date', 'manual_payment_note', 'invoice_number_per_profile'],
    platform_orders: ['checkout_idempotency_key', 'platform_order_idempotency'],
    user_legal_acceptances: ['context_type', 'context_id', 'organization_id', 'user_legal_context_lookup'],
  };
  for (const [table, columns] of Object.entries(required)) {
    for (const column of columns) assert.match(schema.get(table), new RegExp(`\\b${column}\\b`), `${table}.${column}`);
  }
  for (const status of ['incomplete', 'incomplete_expired', 'trialing', 'unpaid', 'paused', 'canceled']) assert.ok(schema.get('platform_subscriptions').includes(`'${status}'`));
  assert.doesNotMatch(schema.get('events'), /\b(capacity|minimum_attendees|language_code|registration_deadline|minimum_age|what_to_bring|meeting_instructions)\b/);
  assert.ok(statements.some(sql => sql.includes('INSERT IGNORE INTO product_configuration') && sql.includes('"subscriptionsEnabled":false,"paidEventsEnabled":false,"paidVenuesEnabled":false')));
});
