import { ProductAccess, accessError } from './product-access.js';

export class ArticlePublishing {
  constructor(queries) { this.queries = queries; this.database = queries.database; this.access = new ProductAccess(this.database); }

  async requireSlot(userId, connection, articleId = null) {
    const access = await this.access.articleAccess(userId, connection);
    const subscribeUrl = `/profile/subscriptions?feature=author.publish_article&returnTo=${encodeURIComponent(articleId ? `/profile/articles/${articleId}/edit` : '/profile/articles')}`;
    if (!access.hasSubscription) throw accessError('ARTICLE_SUBSCRIPTION_REQUIRED', 'Buy an article space subscription before publishing.', 403, { subscribeUrl });
    const [previous] = articleId ? await connection.execute('SELECT article_id FROM article_publications WHERE article_id=?', [articleId]) : [[]];
    if (!previous.length && !access.remaining) throw accessError('ARTICLE_MONTHLY_LIMIT', `You have used your ${access.monthlyLimit} article spaces for this calendar month (UTC).`, 409, { resetsAt: access.resetsAt });
    return !previous.length;
  }

  async transaction(userId, action) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      // Serialize publications per author so simultaneous requests cannot exceed the quota.
      const [users] = await connection.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
      if (!users.length) throw accessError('ARTICLE_AUTHOR_NOT_FOUND', 'Article author not found.', 404);
      const result = await action(connection);
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async create(data) {
    if (data.status !== 'published') return this.queries.createArticle(data);
    return this.transaction(data.authorUserId, async (connection) => {
      await this.requireSlot(data.authorUserId, connection);
      const id = await this.queries.createArticle(data, connection);
      await connection.execute('INSERT INTO article_publications (article_id, user_id, published_at) VALUES (?, ?, UTC_TIMESTAMP())', [id, data.authorUserId]);
      return id;
    });
  }

  async publish(id, userId, role, isIndexable = null) {
    const article = await this.queries.articleForEditor(id, userId, role);
    if (!article) return false;
    return this.transaction(article.authorUserId, async (connection) => {
      const [rows] = await connection.execute('SELECT id, author_user_id AS authorUserId, status FROM articles WHERE id=? FOR UPDATE', [id]);
      if (!rows[0] || (Number(rows[0].authorUserId) !== Number(userId) && role !== 'admin')) return false;
      if (rows[0].status === 'removed') throw accessError('ARTICLE_REMOVED', 'A removed article cannot be published.', 409);
      // Repeated publish requests for an already public article consume no additional space.
      if (rows[0].status === 'published') return true;
      const firstPublication = await this.requireSlot(article.authorUserId, connection, id);
      if (!await this.queries.setArticleStatus(id, userId, role, 'published', isIndexable, connection)) return false;
      if (firstPublication) await connection.execute('INSERT INTO article_publications (article_id, user_id, published_at) VALUES (?, ?, UTC_TIMESTAMP())', [id, article.authorUserId]);
      return true;
    });
  }
}
