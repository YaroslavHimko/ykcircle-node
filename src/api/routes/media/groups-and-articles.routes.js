export function registerMediaGroupsAndArticlesRoutes(
  app,
  {
    publicMediaRoute,
    groupUploadRoute,
    mediaVisibility,
    mediaStream,
    groupFtpService,
    protectedMediaRoute,
    articleUploadRoute,
    optionalAuthenticate,
    ensureTable,
    articleFtpService,
    queries,
  },
) {
  publicMediaRoute({
    route: groupUploadRoute,
    label: 'Group cover',
    visible: mediaVisibility('groupForCover'),
    stream: mediaStream(groupFtpService, 'streamGroupCover'),
    message: 'Group cover not found.',
  });
  protectedMediaRoute({
    kind: 'group',
    tokenKind: 'group-cover',
    visible: mediaVisibility('groupForCover'),
    stream: mediaStream(groupFtpService, 'streamGroupCover'),
    message: 'Group cover not found.',
  });
  app.get(articleUploadRoute, optionalAuthenticate, async (req, res) => {
    try {
      await ensureTable();
      if (
        !articleFtpService ||
        !(await queries.articleImageVisible(
          req.params.filename,
          req.user?.id ?? null,
          req.user?.role ?? null,
        )) ||
        !(await articleFtpService.streamArticleImage(req.params.filename, res))
      )
        return res.status(404).json({ error: 'Article image not found.' });
    } catch (error) {
      console.error('Article image proxy failed:', error.message);
      if (!res.headersSent) return res.status(502).json({ error: 'Unable to load article image.' });
    }
  });
}
