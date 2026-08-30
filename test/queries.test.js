import assert from 'node:assert/strict';
import test from 'node:test';
import { Queries } from '../server/queries.js';

test('validates forum scopes before using table names in SQL', () => {
  const queries = new Queries({ execute: async () => [[]] });

  assert.deepEqual(queries.forumTables('group'), { threads: 'group_forum_threads', messages: 'group_forum_messages', owner: 'group_id' });
  assert.deepEqual(queries.forumTables('event'), { threads: 'event_forum_threads', messages: 'event_forum_messages', owner: 'event_id' });
  assert.throws(() => queries.forumTables('community'), /Invalid forum scope/);
  assert.throws(() => queries.forumTables('group; DROP TABLE users'), /Invalid forum scope/);
});

test('paginates public articles and maps stored tag lists to arrays', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 3, title: 'Published', tagSlugs: 'culture,summer' }, { id: 4, title: 'No tags', tagSlugs: null }]];
    },
  });

  const articles = await queries.articles({ categorySlug: 'news', tagSlug: 'culture', page: 2, limit: 999 });

  assert.deepEqual(articles, [
    { id: 3, title: 'Published', tagSlugs: undefined, tags: ['culture', 'summer'] },
    { id: 4, title: 'No tags', tagSlugs: undefined, tags: [] },
  ]);
  assert.match(calls[0].sql, /BINARY a\.status = BINARY 'published'/);
  assert.match(calls[0].sql, /c\.slug = \?/);
  assert.match(calls[0].sql, /filter_t\.slug = \?/);
  assert.deepEqual(calls[0].parameters, ['news', 'culture', 50, 50]);
});

test('publishing an article records the timestamp after creating it', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return calls.length === 1 ? [{ insertId: 28 }] : [{ affectedRows: 1 }];
    },
  });

  const id = await queries.createArticle({ slug: 'hello', authorUserId: 4, categoryId: 2, title: 'Hello', excerpt: 'Short', body: 'Body', status: 'published', isIndexable: true });

  assert.equal(id, 28);
  assert.match(calls[0].sql, /INSERT INTO articles/);
  assert.deepEqual(calls[1].parameters, [28]);
  assert.match(calls[1].sql, /published_at = NOW\(\)/);
});

test('limits non-admin role changes to eligible customer accounts', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [{ affectedRows: 1 }];
    },
  });

  assert.equal(await queries.updateUserRole(8, 'admin', 'manager'), true);
  assert.deepEqual(calls[0].parameters, ['organizer', 8]);
  assert.match(calls[0].sql, /role = 'customer'/);
});

test('allows stored event covers for drafts and uses binary filename comparisons', async () => {
  const calls = [];
  const queries = new Queries({
    execute: async (sql, parameters) => {
      calls.push({ sql, parameters });
      return [[{ id: 1 }]];
    },
  });

  assert.deepEqual(await queries.eventCover('event-1-1786906288459.png'), { id: 1 });
  assert.match(calls[0].sql, /BINARY cover_image = BINARY \?/);
  assert.match(calls[0].sql, /BINARY cover_image LIKE CONCAT\(BINARY '%\/', BINARY \?\)/);
  assert.doesNotMatch(calls[0].sql, /status = 'Published'|visibility = 'Public'/);
  assert.deepEqual(calls[0].parameters, ['event-1-1786906288459.png', 'event-1-1786906288459.png']);
});

test('keeps rich event location columns and values aligned', async () => {
  const queries = new Queries({ execute: async () => [[]] });
  let insert;
  await queries.insertRichEvent({ query: async (sql, values) => { insert = { sql, values }; return [{ insertId: 1 }]; } }, {
    managerId: 1, title: 'Location test', locationType: 'custom', customFormattedAddress: 'Stockholm, Sweden', customLatitude: 59.3293, customLongitude: 18.0686,
  }, 1);

  assert.equal(insert.values.length, 52);
  assert.equal((insert.sql.match(/\?/g) || []).length, 52);
  assert.match(insert.sql, /venue_id, custom_address_line_1/);
  assert.match(insert.sql, /online_url, online_platform/);
});
