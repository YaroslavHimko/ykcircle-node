export class ArticlesRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async articleCategories() {
    const [rows] = await this.database.execute(
      'SELECT id, name, slug, description, sort_order AS sortOrder FROM article_categories WHERE is_active = TRUE ORDER BY sort_order, name',
    );
    return rows;
  }

  articleColumns() {
    return "a.id, a.slug, a.title, a.excerpt, a.body, a.cover_image AS coverImage, a.cover_alt_text AS coverAltText, a.status, a.is_indexable AS isIndexable, a.published_at AS publishedAt, a.created_at AS createdAt, a.updated_at AS updatedAt, a.author_user_id AS authorUserId, u.name AS authorName, c.id AS categoryId, c.name AS categoryName, c.slug AS categorySlug, GROUP_CONCAT(DISTINCT t.slug ORDER BY t.slug SEPARATOR ',') AS tagSlugs";
  }

  async articles({
    categorySlug = null,
    tagSlug = null,
    page = 1,
    limit = 20,
    editorId = null,
    editorRole = null,
    ownedOnly = false,
  } = {}) {
    const privileged = editorId != null;
    const admin = editorRole === 'admin' && !ownedOnly;
    const conditions = [
      privileged
        ? `BINARY a.status <> BINARY 'removed'${admin ? '' : ' AND a.author_user_id = ?'}`
        : "BINARY a.status = BINARY 'published' AND a.is_indexable = TRUE AND a.published_at IS NOT NULL AND a.published_at <= NOW()",
    ];
    const params = privileged && !admin ? [editorId] : [];
    if (categorySlug) {
      conditions.push('c.slug = ?');
      params.push(categorySlug);
    }
    if (tagSlug) {
      conditions.push(
        'EXISTS (SELECT 1 FROM article_tag_assignments filter_ata JOIN article_tags filter_t ON filter_t.id = filter_ata.tag_id WHERE filter_ata.article_id = a.id AND filter_t.slug = ?)',
      );
      params.push(tagSlug);
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * safeLimit;
    const [rows] = await this.database.execute(
      `SELECT ${this.queries.articleColumns()} FROM articles a JOIN users u ON u.id = a.author_user_id LEFT JOIN article_categories c ON c.id = a.category_id LEFT JOIN article_tag_assignments ata ON ata.article_id = a.id LEFT JOIN article_tags t ON t.id = ata.tag_id WHERE ${conditions.join(' AND ')} GROUP BY a.id, u.name, c.id, c.name, c.slug ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset],
    );
    return rows.map((row) => ({
      ...row,
      tags: row.tagSlugs ? row.tagSlugs.split(',') : [],
      tagSlugs: undefined,
    }));
  }

  async articleBySlug(slug, userId = null, role = null) {
    const isAdmin = role === 'admin';
    const [rows] = await this.database.execute(
      `SELECT ${this.queries.articleColumns()} FROM articles a JOIN users u ON u.id = a.author_user_id LEFT JOIN article_categories c ON c.id = a.category_id LEFT JOIN article_tag_assignments ata ON ata.article_id = a.id LEFT JOIN article_tags t ON t.id = ata.tag_id WHERE a.slug = ? AND (${isAdmin ? "BINARY a.status <> BINARY 'removed'" : "(BINARY a.status = BINARY 'published' AND a.is_indexable = TRUE AND a.published_at IS NOT NULL AND a.published_at <= NOW()) OR a.author_user_id = ?"}) GROUP BY a.id, u.name, c.id, c.name, c.slug`,
      isAdmin ? [slug] : [slug, userId],
    );
    if (!rows[0]) return null;
    return {
      ...rows[0],
      tags: rows[0].tagSlugs ? rows[0].tagSlugs.split(',') : [],
      tagSlugs: undefined,
    };
  }

  async articleForEditor(id, userId, role) {
    const privileged = role === 'admin';
    const [rows] = await this.database.execute(
      `SELECT id, slug, author_user_id AS authorUserId, cover_image AS coverImage FROM articles WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'}`,
      privileged ? [id] : [id, userId],
    );
    return rows[0] || null;
  }

  async createArticle(data, executor = this.database) {
    const [result] = await executor.execute(
      'INSERT INTO articles (slug, author_user_id, category_id, title, excerpt, body, status, is_indexable, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [
        data.slug,
        data.authorUserId,
        data.categoryId,
        data.title,
        data.excerpt,
        data.body,
        data.status,
        data.isIndexable,
      ],
    );
    if (data.status === 'published')
      await executor.execute('UPDATE articles SET published_at = NOW() WHERE id = ?', [
        result.insertId,
      ]);
    return result.insertId;
  }

  async updateArticle(id, userId, role, data) {
    const privileged = role === 'admin';
    const [result] = await this.database.execute(
      `UPDATE articles SET category_id=?, title=?, excerpt=?, body=?, is_indexable=? WHERE id=?${privileged ? '' : ' AND author_user_id=?'}`,
      [...data, id, ...(privileged ? [] : [userId])],
    );
    return result.affectedRows > 0;
  }

  async setArticleStatus(id, userId, role, status, isIndexable = null, executor = this.database) {
    const privileged = role === 'admin';
    const params = [status];
    let sql = 'UPDATE articles SET status = ?';
    if (status === 'published') sql += ', published_at = COALESCE(published_at, NOW())';
    if (isIndexable !== null) {
      sql += ', is_indexable = ?';
      params.push(isIndexable);
    }
    sql += ` WHERE id = ?${privileged ? '' : ' AND author_user_id = ?'}`;
    params.push(id, ...(privileged ? [] : [userId]));
    const [result] = await executor.execute(sql, params);
    return result.affectedRows > 0;
  }

  async setArticleCover(id, userId, role, filename, altText) {
    const privileged = role === 'admin';
    const [result] = await this.database.execute(
      `UPDATE articles SET cover_image=?, cover_alt_text=? WHERE id=?${privileged ? '' : ' AND author_user_id=?'}`,
      [filename, altText, id, ...(privileged ? [] : [userId])],
    );
    return result.affectedRows > 0;
  }

  async addArticleMedia(articleId, filename, altText, caption) {
    const [rows] = await this.database.execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM article_media WHERE article_id = ?',
      [articleId],
    );
    const [result] = await this.database.execute(
      'INSERT INTO article_media (article_id, filename, alt_text, caption, sort_order) VALUES (?, ?, ?, ?, ?)',
      [articleId, filename, altText, caption, rows[0].nextOrder],
    );
    return result.insertId;
  }

  async articleMedia(articleId) {
    const [rows] = await this.database.execute(
      'SELECT id, filename, alt_text AS altText, caption, sort_order AS sortOrder, created_at AS createdAt FROM article_media WHERE article_id = ? ORDER BY sort_order, id',
      [articleId],
    );
    return rows;
  }

  async articleMediaItem(id, articleId) {
    const [rows] = await this.database.execute(
      'SELECT id, filename FROM article_media WHERE id = ? AND article_id = ?',
      [id, articleId],
    );
    return rows[0] || null;
  }

  async articleImageVisible(filename, userId = null, role = null) {
    const isAdmin = role === 'admin';
    const [rows] = await this.database.execute(
      `SELECT a.id FROM articles a LEFT JOIN article_media m ON m.article_id = a.id WHERE (a.cover_image = ? OR m.filename = ?) AND (${isAdmin ? 'TRUE' : "(BINARY a.status = BINARY 'published' AND a.is_indexable = TRUE AND a.published_at IS NOT NULL AND a.published_at <= NOW()) OR a.author_user_id = ?"}) LIMIT 1`,
      isAdmin ? [filename, filename] : [filename, filename, userId],
    );
    return rows[0] || null;
  }

  async deleteArticleMedia(id, articleId) {
    const [result] = await this.database.execute(
      'DELETE FROM article_media WHERE id = ? AND article_id = ?',
      [id, articleId],
    );
    return result.affectedRows > 0;
  }

  async syncArticleTags(articleId, tags) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM article_tag_assignments WHERE article_id = ?', [
        articleId,
      ]);
      for (const tag of tags) {
        await connection.execute(
          'INSERT INTO article_tags (name, slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
          [tag.name, tag.slug],
        );
        const [rows] = await connection.execute('SELECT id FROM article_tags WHERE slug = ?', [
          tag.slug,
        ]);
        await connection.execute(
          'INSERT INTO article_tag_assignments (article_id, tag_id) VALUES (?, ?)',
          [articleId, rows[0].id],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
