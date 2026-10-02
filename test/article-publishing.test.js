import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { ArticlePublishing } from '../server/article-publishing.js';
import { ProductAccess, PUBLISH_ARTICLE } from '../server/product-access.js';
import { Queries } from '../server/queries.js';
import { Api } from '../server/api.js';

function fixture() {
  const state = { articles: [], publications: [], active: new Set(), subscriptionsEnabled: true, limit: 1, statements: [] };
  const execute = async (sql, p = []) => {
    state.statements.push({ sql, p });
    if (sql.includes('FROM product_configuration')) return [[{ settings: { articlesPerMonth: state.limit, subscriptionsEnabled: state.subscriptionsEnabled } }]];
    if (sql.includes('FROM platform_entitlements e JOIN platform_subscriptions')) {
      assert.match(sql, /s.status='active'/);
      assert.match(sql, /s.current_period_end>UTC_TIMESTAMP\(\)/);
      assert.match(sql, /e.ends_at>UTC_TIMESTAMP\(\)/);
      assert.match(sql, /e.revoked_at IS NULL/);
      assert.equal(p[1], PUBLISH_ARTICLE);
      return [state.active.has(p[0]) ? [{ feature: PUBLISH_ARTICLE, source: 'subscription' }] : []];
    }
    if (sql.includes('COUNT(*) AS used')) {
      assert.match(sql, /published_at>=DATE_FORMAT\(UTC_TIMESTAMP\(\), '%Y-%m-01'\)/);
      assert.match(sql, /published_at<DATE_ADD/);
      return [[{ used: state.publications.filter(row => row.userId === p[0] && !row.previousMonth).length, resetsAt: '2026-11-01T00:00:00Z' }]];
    }
    if (sql.startsWith('SELECT article_id FROM article_publications')) return [state.publications.filter(row => row.articleId === p[0])];
    if (sql.startsWith('INSERT INTO article_publications')) { state.publications.push({ articleId: p[0], userId: p[1] }); return [{}]; }
    if (sql.includes('FROM articles WHERE id=? FOR UPDATE')) return [state.articles.filter(row => row.id === p[0])];
    if (sql.startsWith('SELECT id, slug, author_user_id')) return [state.articles.filter(row => row.id === p[0] && (p.length === 1 || row.authorUserId === p[1]))];
    if (sql.startsWith('INSERT INTO articles')) { const id = state.articles.length + 1; state.articles.push({ id, slug: p[0], authorUserId: p[1], title: p[3], status: p[6] }); return [{ insertId: id }]; }
    if (sql.startsWith('UPDATE articles SET published_at')) return [{ affectedRows: 1 }];
    if (sql.startsWith('UPDATE articles SET status')) { const article = state.articles.find(row => row.id === p[1]); if (!article) return [{ affectedRows: 0 }]; article.status = p[0]; return [{ affectedRows: 1 }]; }
    throw new Error(`Unhandled SQL: ${sql}`);
  };
  let queue = Promise.resolve();
  const database = { execute, getConnection: async () => {
    let unlock, snapshot;
    return { beginTransaction: async () => {}, execute: async (sql, p) => {
      if (sql.startsWith('SELECT id FROM users')) {
        const previous = queue; queue = new Promise(resolve => { unlock = resolve; }); await previous;
        snapshot = structuredClone({ articles: state.articles, publications: state.publications });
        return [[{ id: p[0] }]];
      }
      return execute(sql, p);
    }, commit: async () => { snapshot = null; }, rollback: async () => { if (snapshot) Object.assign(state, snapshot); }, release: () => unlock?.() };
  } };
  const queries = new Queries(database);
  return { state, database, queries, service: new ArticlePublishing(queries) };
}
const article = (overrides = {}) => ({ authorUserId: 1, slug: 'my-article', categoryId: null, title: 'My new article', excerpt: 'An interesting article introduction.', body: 'An article body with enough content to pass validation.', status: 'draft', isIndexable: true, ...overrides });

test('free launch allows publishing without a subscription or paid quota', async () => {
  const f = fixture(); f.state.subscriptionsEnabled = false; f.state.limit = 0;
  const id = await f.service.create(article({ status: 'published' }));
  const draft = await f.service.create(article({ slug: 'another-story' }));
  assert.equal(await f.service.publish(draft, 1, 'customer'), true);
  await f.queries.setArticleStatus(id, 1, 'customer', 'archived');
  assert.equal(await f.service.publish(id, 1, 'customer'), true);
  assert.equal(f.state.publications.length, 2);
  const access = await f.service.access.articleAccess(1);
  assert.equal(access.subscriptionsEnabled, false);
  assert.equal(access.hasSubscription, false);
  assert.equal(access.canPublish, true);
  assert.equal(access.accessSource, 'early_access');
  f.state.subscriptionsEnabled = true;
  await assert.rejects(f.service.create(article({ status: 'published' })), { code: 'ARTICLE_SUBSCRIPTION_REQUIRED' });
});

test('drafts are free, while direct publishing needs a paid article subscription', async () => {
  const f = fixture();
  assert.equal(await f.service.create(article()), 1);
  await assert.rejects(f.service.create(article({ status: 'published' })), { code: 'ARTICLE_SUBSCRIPTION_REQUIRED' });
  await assert.rejects(f.service.publish(1, 1, 'customer'), { code: 'ARTICLE_SUBSCRIPTION_REQUIRED' });
  assert.equal(f.state.articles.length, 1);
  assert.equal(f.state.publications.length, 0);
});

test('concurrent publication consumes one space; archive and republish cannot reset usage', async () => {
  const f = fixture(); f.state.active.add(1);
  const ids = await Promise.all([f.service.create(article()), f.service.create(article({ slug: 'second' }))]);
  const outcomes = await Promise.allSettled(ids.map(id => f.service.publish(id, 1, 'customer')));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'ARTICLE_MONTHLY_LIMIT');
  const published = f.state.publications[0].articleId;
  await f.service.publish(published, 1, 'customer');
  await f.queries.setArticleStatus(published, 1, 'customer', 'archived');
  await f.service.publish(published, 1, 'customer');
  assert.equal(f.state.publications.length, 1);
  assert.equal((await f.service.access.articleAccess(1)).remaining, 0);
});

test('quotas reset by month and admins publish using the author subscription', async () => {
  const f = fixture(); f.state.active.add(99);
  const id = await f.service.create(article());
  assert.equal(await f.service.publish(id, 2, 'customer'), false);
  await assert.rejects(f.service.publish(id, 99, 'admin'), { code: 'ARTICLE_SUBSCRIPTION_REQUIRED' });
  f.state.active.add(1); f.state.publications.push({ articleId: 98, userId: 1, previousMonth: true });
  assert.equal(await f.service.publish(id, 99, 'admin'), true);
  assert.equal(f.state.publications[1].userId, 1);
  f.state.active.delete(1);
  await f.queries.setArticleStatus(id, 1, 'customer', 'archived');
  await assert.rejects(f.service.publish(id, 1, 'customer'), { code: 'ARTICLE_SUBSCRIPTION_REQUIRED' });
});

test('zero allowance blocks first publication and a removed article cannot be published', async () => {
  const f = fixture(); f.state.active.add(1); f.state.limit = 0;
  await assert.rejects(f.service.create(article({ status: 'published' })), { code: 'ARTICLE_MONTHLY_LIMIT' });
  const id = await f.service.create(article());
  f.state.articles[0].status = 'removed';
  await assert.rejects(f.service.publish(id, 1, 'customer'), { code: 'ARTICLE_REMOVED' });
});

test('monthly allowance rejects invalid configuration', async () => {
  const service = new ProductAccess({});
  for (const value of [-1, 1001, 1.5, '1', true, null]) await assert.rejects(service.configure({ articlesPerMonth: value }, 1), { code: 'INVALID_CONFIGURATION' });
});

test('every registered role gets an owner-scoped article workspace', async () => {
  for (const role of ['customer', 'organizer', 'venue_owner', 'manager']) {
    const queries = new Queries({ execute: async (sql, p) => { assert.match(sql, /a.author_user_id = \?/); assert.equal(p[0], 7); return [[]]; } });
    await queries.articles({ editorId: 7, editorRole: role });
  }
});

test('My Articles includes only the signed-in author even for administrators', async () => {
  for (const role of ['customer', 'organizer', 'venue_owner', 'manager', 'admin']) {
    const queries = new Queries({ execute: async (sql, p) => {
      assert.match(sql, /BINARY a.status <> BINARY 'removed' AND a.author_user_id = \?/);
      assert.deepEqual(p, [7, 50, 0]);
      return [[]];
    } });
    await queries.articles({ editorId: 7, editorRole: role, ownedOnly: true, limit: 50 });
  }
});

test('article HTTP routes allow customer drafts and guard both publication entry points', async (t) => {
  const f = fixture();
  const secret = 'article test secret with at least thirty two characters';
  const user = { id: 1, role: 'customer', isEmailConfirmed: true, sessionVersion: 1 };
  const articleLists = [];
  Object.assign(f.queries, { initialize: async () => {}, findUserById: async () => user,
    syncArticleTags: async () => {}, articleBySlug: async slug => f.state.articles.find(row => row.slug === slug),
    updateArticle: async () => true, articles: async options => { articleLists.push(options); return f.state.articles; } });
  const ftp = { publicPath: () => '/uploads/articles' };
  const api = new Api({ config: { site: { siteUrl: 'https://ykcircle.test' }, runtime: { authSecret: secret, maps: {} } }, database: f.database, queries: f.queries, emailService: {}, ftpService: ftp, eventFtpService: ftp, venueFtpService: ftp, groupFtpService: ftp, articleFtpService: ftp });
  const app = express(); app.use(express.json()); api.register(app);
  const server = await new Promise(resolve => { const listener = app.listen(0, () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const payload = Buffer.from(JSON.stringify({ id: 1, sessionVersion: 1, exp: Date.now() + 60000 })).toString('base64url');
  const token = `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
  const request = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/api/my/articles')).status, 200);
  user.role = 'admin';
  assert.equal((await request('/api/my/articles?ownedOnly=true&editorId=999')).status, 200);
  assert.deepEqual(articleLists.at(-1), { editorId: 1, editorRole: 'admin', ownedOnly: true, limit: 50 });
  user.role = 'customer';
  assert.equal((await request('/api/articles', 'POST', article())).status, 201);
  let response = await request('/api/articles', 'POST', article({ status: 'published' }));
  assert.equal(response.status, 403); assert.equal((await response.json()).code, 'ARTICLE_SUBSCRIPTION_REQUIRED');
  response = await request('/api/articles/1/status', 'PATCH', { status: 'published' });
  assert.equal(response.status, 403); assert.match((await response.json()).subscribeUrl, /author.publish_article/);
  assert.equal((await request('/api/articles/1', 'PATCH', article({ status: 'published' }))).status, 200);
  assert.equal(f.state.articles[0].status, 'draft');
  f.state.active.add(1);
  assert.equal((await request('/api/articles/1/status', 'PATCH', { status: 'published' })).status, 200);
  assert.equal((await request('/api/my/article-access')).status, 200);
  response = await request('/api/articles', 'POST', article({ slug: 'second-article', status: 'published' }));
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'ARTICLE_MONTHLY_LIMIT');
  user.isEmailConfirmed = false;
  assert.equal((await request('/api/articles', 'POST', article())).status, 403);
});
