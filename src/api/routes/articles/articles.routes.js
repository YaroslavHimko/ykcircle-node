export function registerArticlesRoutes(
  app,
  {
    ensureTable,
    queries,
    articleSlug,
    optionalAuthenticate,
    decorateArticleImageUrls,
    authenticate,
    requireVerifiedUser,
    articleInput,
    validateArticle,
    articlePublishing,
    parseArticleImage,
    articleFtpService,
    articleImageUrl,
  },
) {
  app.get('/api/article-categories', async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.articleCategories());
    } catch {
      return res.status(500).json({ error: 'Unable to load article categories.' });
    }
  });
  app.get('/api/articles', async (req, res) => {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return res
        .status(422)
        .json({ error: 'page must be positive and limit must be between 1 and 50.' });
    try {
      await ensureTable();
      return res.json(
        await queries.articles({
          categorySlug: req.query.category ? articleSlug(req.query.category) : null,
          tagSlug: req.query.tag ? articleSlug(req.query.tag) : null,
          page,
          limit,
        }),
      );
    } catch (error) {
      console.error('Article lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load articles.' });
    }
  });
  app.get('/api/articles/:slug', optionalAuthenticate, async (req, res) => {
    try {
      await ensureTable();
      const article = await queries.articleBySlug(
        articleSlug(req.params.slug),
        req.user?.id ?? null,
        req.user?.role ?? null,
      );
      if (!article) return res.status(404).json({ error: 'Article not found.' });
      article.media = await queries.articleMedia(article.id);
      return res.json(decorateArticleImageUrls(article));
    } catch (error) {
      console.error('Article lookup by slug failed:', error.message);
      return res.status(500).json({ error: 'Unable to load article.' });
    }
  });
  app.get('/api/my/articles', authenticate, async (req, res) => {
    try {
      await ensureTable();
      return res.json(
        await queries.articles({
          editorId: req.user.id,
          editorRole: req.user.role,
          ownedOnly: req.query.ownedOnly === 'true',
          limit: 50,
        }),
      );
    } catch (error) {
      console.error('My article lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load your articles.' });
    }
  });
  app.post('/api/articles', authenticate, requireVerifiedUser, async (req, res) => {
    const article = articleInput(req.body);
    if (req.user.role !== 'admin') article.isIndexable = true;
    const fields = validateArticle(article, req.user.role === 'admin');
    if (Object.keys(fields).length)
      return res.status(422).json({ error: 'Article is invalid.', fields });
    const slug = articleSlug(req.body.slug || article.title);
    if (!slug || slug.length > 180)
      return res.status(422).json({
        error: 'Article is invalid.',
        fields: { slug: 'Provide a valid slug up to 180 characters.' },
      });
    try {
      await ensureTable();
      const id = await articlePublishing.create({ ...article, slug, authorUserId: req.user.id });
      await queries.syncArticleTags(id, article.tags);
      return res.status(201).json(await queries.articleBySlug(slug, req.user.id, req.user.role));
    } catch (error) {
      if (error.status)
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          subscribeUrl: error.subscribeUrl,
          resetsAt: error.resetsAt,
        });
      if (error.code === 'ER_DUP_ENTRY')
        return res.status(409).json({ error: 'An article with this slug already exists.' });
      console.error('Article creation failed:', error.message);
      return res.status(500).json({ error: 'Unable to create article.' });
    }
  });
  app.patch('/api/articles/:id', authenticate, requireVerifiedUser, async (req, res) => {
    const id = Number(req.params.id);
    const article = articleInput(req.body);
    if (req.user.role !== 'admin') article.isIndexable = true;
    const fields = validateArticle(article, req.user.role === 'admin');
    if (!Number.isInteger(id) || id < 1 || Object.keys(fields).length)
      return res.status(422).json({ error: 'Article is invalid.', fields });
    try {
      await ensureTable();
      if (
        !(await queries.updateArticle(id, req.user.id, req.user.role, [
          article.categoryId,
          article.title,
          article.excerpt,
          article.body,
          article.isIndexable,
        ]))
      )
        return res.status(404).json({ error: 'Article not found or not owned by you.' });
      await queries.syncArticleTags(id, article.tags);
      const editor = await queries.articleForEditor(id, req.user.id, req.user.role);
      return res.json(await queries.articleBySlug(editor.slug, req.user.id, req.user.role));
    } catch (error) {
      console.error('Article update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update article.' });
    }
  });
  app.patch('/api/articles/:id/status', authenticate, requireVerifiedUser, async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body.status || '');
    const allowed =
      req.user.role === 'admin'
        ? ['draft', 'published', 'archived', 'removed']
        : ['draft', 'published', 'archived'];
    if (!Number.isInteger(id) || id < 1 || !allowed.includes(status))
      return res.status(422).json({ error: 'Invalid article status.' });
    try {
      await ensureTable();
      if (
        !(status === 'published'
          ? await articlePublishing.publish(
              id,
              req.user.id,
              req.user.role,
              req.user.role === 'admin' && typeof req.body.isIndexable === 'boolean'
                ? req.body.isIndexable
                : null,
            )
          : await queries.setArticleStatus(
              id,
              req.user.id,
              req.user.role,
              status,
              req.user.role === 'admin' && typeof req.body.isIndexable === 'boolean'
                ? req.body.isIndexable
                : null,
            ))
      )
        return res.status(404).json({ error: 'Article not found or not owned by you.' });
      return res.json({ id, status });
    } catch (error) {
      if (error.status)
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          subscribeUrl: error.subscribeUrl,
          resetsAt: error.resetsAt,
        });
      console.error('Article status update failed:', error.message);
      return res.status(500).json({ error: 'Unable to update article status.' });
    }
  });
  app.post(
    '/api/articles/:id/cover',
    authenticate,
    requireVerifiedUser,
    parseArticleImage,
    async (req, res) => {
      const id = Number(req.params.id);
      const altText = String(req.body.altText || '').trim();
      if (
        !Number.isInteger(id) ||
        id < 1 ||
        !req.file ||
        altText.length < 3 ||
        altText.length > 200
      )
        return res.status(422).json({
          error: 'Cover image is invalid.',
          fields: { altText: 'Alt text must be between 3 and 200 characters.' },
        });
      try {
        await ensureTable();
        const article = await queries.articleForEditor(id, req.user.id, req.user.role);
        if (!article)
          return res.status(404).json({ error: 'Article not found or not owned by you.' });
        const filename = await articleFtpService.uploadArticleImage(id, req.file);
        if (!(await queries.setArticleCover(id, req.user.id, req.user.role, filename, altText))) {
          await articleFtpService.deleteArticleImage(filename);
          return res.status(404).json({ error: 'Article not found or not owned by you.' });
        }
        if (article.coverImage) {
          try {
            await articleFtpService.deleteArticleImage(article.coverImage);
          } catch (error) {
            console.error('Previous article cover cleanup failed:', error.message);
          }
        }
        return res.json({ coverImage: articleImageUrl(filename), coverAltText: altText });
      } catch (error) {
        if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message });
        if (error.code === 'FTP_NOT_CONFIGURED')
          return res.status(503).json({ error: 'Article image storage is not configured.' });
        return res.status(502).json({ error: 'Unable to upload article image.' });
      }
    },
  );
  app.post(
    '/api/articles/:id/media',
    authenticate,
    requireVerifiedUser,
    parseArticleImage,
    async (req, res) => {
      const id = Number(req.params.id);
      const altText = String(req.body.altText || '').trim();
      const caption = req.body.caption == null ? null : String(req.body.caption).trim() || null;
      if (
        !Number.isInteger(id) ||
        id < 1 ||
        !req.file ||
        altText.length < 3 ||
        altText.length > 200 ||
        caption?.length > 500
      )
        return res.status(422).json({ error: 'Article image is invalid.' });
      try {
        await ensureTable();
        if (!(await queries.articleForEditor(id, req.user.id, req.user.role)))
          return res.status(404).json({ error: 'Article not found or not owned by you.' });
        const filename = await articleFtpService.uploadArticleImage(id, req.file);
        const mediaId = await queries.addArticleMedia(id, filename, altText, caption);
        return res
          .status(201)
          .json({ id: mediaId, filename, url: articleImageUrl(filename), altText, caption });
      } catch (error) {
        if (error.code === 'INVALID_IMAGE') return res.status(422).json({ error: error.message });
        if (error.code === 'FTP_NOT_CONFIGURED')
          return res.status(503).json({ error: 'Article image storage is not configured.' });
        return res.status(502).json({ error: 'Unable to upload article image.' });
      }
    },
  );
  app.delete(
    '/api/articles/:articleId/media/:mediaId',
    authenticate,
    requireVerifiedUser,
    async (req, res) => {
      const articleId = Number(req.params.articleId);
      const mediaId = Number(req.params.mediaId);
      if (!Number.isInteger(articleId) || !Number.isInteger(mediaId))
        return res.status(404).json({ error: 'Article image not found.' });
      try {
        await ensureTable();
        if (!(await queries.articleForEditor(articleId, req.user.id, req.user.role)))
          return res.status(404).json({ error: 'Article not found or not owned by you.' });
        const media = await queries.articleMediaItem(mediaId, articleId);
        if (!media) return res.status(404).json({ error: 'Article image not found.' });
        await queries.deleteArticleMedia(mediaId, articleId);
        try {
          await articleFtpService.deleteArticleImage(media.filename);
        } catch (error) {
          console.error('Article image cleanup failed:', error.message);
        }
        return res.json({ message: 'Article image deleted.' });
      } catch {
        return res.status(500).json({ error: 'Unable to delete article image.' });
      }
    },
  );
}
