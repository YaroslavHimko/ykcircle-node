export function createMediaPresentation({
  articleFtpService,
  groupFtpService,
  eventFtpService,
  eventCoverToken,
  groupCoverToken,
}) {
  const articleImageUrl = (filename) =>
    `${articleFtpService.publicPath()}/${encodeURIComponent(filename)}`;
  const protectedMediaUrl = (kind, filename, token) =>
    `/api/media/${kind}/${encodeURIComponent(token)}/${encodeURIComponent(filename)}`;
  const groupCoverUrl = (filename, token = null) =>
    filename
      ? token
        ? protectedMediaUrl('group', filename, token)
        : `${groupFtpService.publicPath()}/${encodeURIComponent(filename)}`
      : null;
  const eventCoverUrl = (filename, token = null) =>
    filename
      ? token
        ? protectedMediaUrl('event', filename, token)
        : `${eventFtpService.publicPath()}/${encodeURIComponent(filename)}`
      : null;
  const decorateEventImage = (event, viewer = {}) => {
    if (!event || !event.coverImage) return event;
    const filename = event.coverImage;
    const { userId = null, role = null } = viewer;
    const privileged = ['manager', 'admin'].includes(role);
    const isPublic = event.status === 'Published' && event.visibility === 'Public';
    const canManage = privileged || (userId != null && event.managerId === userId);
    const token =
      !isPublic && (canManage || viewer.attendingAccess === true)
        ? eventCoverToken(filename)
        : null;
    const url = eventCoverUrl(filename, token);
    // Never expose the persisted value as a browser source. Older clients
    // read coverImage directly, and historic rows can contain an absolute
    // localhost signed URL created during development. The resolved URL is
    // always derived from the filename and current deployment instead.
    return { ...event, coverImage: url, coverImageUrl: url, thumbnailUrl: url };
  };
  const decorateEventImages = (events, viewer) =>
    events.map((event) => decorateEventImage(event, viewer));
  const decorateGroup = (group, viewer = {}) => {
    if (!group) return group;
    const { role = null } = viewer;
    const privileged = ['manager', 'admin'].includes(role);
    const canViewPrivate = privileged || group.isOrganizer || group.isMember;
    const needsToken = group.visibility !== 'Public' && canViewPrivate;
    if (group.coverImage)
      group.coverImageUrl = groupCoverUrl(
        group.coverImage,
        needsToken ? groupCoverToken(group.coverImage) : null,
      );
    if (Array.isArray(group.events)) group.events = decorateEventImages(group.events, viewer);
    return group;
  };
  const decorateGroups = (groups, viewer) => groups.map((group) => decorateGroup(group, viewer));
  const decorateArticleImageUrls = (article) => {
    if (article.coverImage) article.coverImageUrl = articleImageUrl(article.coverImage);
    article.body = String(article.body || '').replace(
      /\/uploads\/article-images\//g,
      articleImageUrl('article-image-placeholder.png').replace(
        /article-image-placeholder\.png$/,
        '',
      ),
    );
    article.media = article.media?.map((media) => ({
      ...media,
      url: articleImageUrl(media.filename),
    }));
    return article;
  };
  return {
    articleImageUrl,
    protectedMediaUrl,
    decorateEventImage,
    decorateEventImages,
    decorateGroup,
    decorateGroups,
    decorateArticleImageUrls,
  };
}
