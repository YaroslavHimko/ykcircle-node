export function createArticlesValidation() {
  const articleSlug = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const articleTags = (values) => {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
      .map((value) => String(value).trim())
      .filter(Boolean)
      .map((name) => ({ name: name.slice(0, 80), slug: articleSlug(name).slice(0, 100) }))
      .filter((tag) => tag.slug && !seen.has(tag.slug) && (seen.add(tag.slug) || true))
      .slice(0, 8);
  };
  const sanitizeRichText = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\r\n|\r|\n/g, '<br>');
  const articleInput = (body) => {
    const input = body && typeof body === 'object' ? body : {};
    const rawCategoryId = input.categoryId;
    return {
      categoryId:
        rawCategoryId == null || rawCategoryId === '' || rawCategoryId === 'null'
          ? null
          : Number(rawCategoryId),
      title: String(input.title || '').trim(),
      excerpt: String(input.excerpt || '').trim(),
      body: sanitizeRichText(input.body).trim(),
      tags: articleTags(input.tags),
      isIndexable: input.isIndexable !== false,
      status: input.status || 'draft',
    };
  };
  const validateArticle = (article, isAdmin = false) => {
    const fields = {};
    if (
      article.categoryId !== null &&
      (!Number.isInteger(article.categoryId) || article.categoryId < 1)
    )
      fields.categoryId = 'Choose a valid category.';
    if (article.title.length < 8 || article.title.length > 200)
      fields.title = 'Title must be between 8 and 200 characters.';
    if (article.excerpt.length < 20 || article.excerpt.length > 400)
      fields.excerpt = 'Excerpt must be between 20 and 400 characters.';
    if (article.body.length < 40 || article.body.length > 200000)
      fields.body = 'Article body must be between 40 and 200,000 characters.';
    if (
      !['draft', 'published'].includes(article.status) &&
      !(isAdmin && ['archived', 'removed'].includes(article.status))
    )
      fields.status = 'Status must be draft or published.';
    return fields;
  };
  return { articleSlug, articleInput, validateArticle };
}
