export function registerModerationReportsRoutes(
  app,
  {
    optionalAuthenticate,
    reportEntityTypes,
    reportReasonCodes,
    ensureTable,
    reportReference,
    queries,
  },
) {
  app.post('/api/reports', optionalAuthenticate, async (req, res) => {
    const entityType = String(req.body.entityType || '').trim();
    const entityId = req.body.entityId == null ? null : String(req.body.entityId).trim() || null;
    const contentUrl =
      req.body.contentUrl == null ? null : String(req.body.contentUrl).trim() || null;
    const reasonCode = String(req.body.reasonCode || '').trim();
    const description = String(req.body.description || '').trim();
    const supportingDetails =
      req.body.supportingDetails == null ? null : String(req.body.supportingDetails).trim() || null;
    const reporterEmail =
      req.user?.email ||
      (req.body.reporterEmail == null
        ? null
        : String(req.body.reporterEmail).trim().toLowerCase() || null);
    const allegedIllegal = req.body.allegedIllegal === true;
    const goodFaithDeclared = req.body.goodFaithDeclared === true;
    if (
      !reportEntityTypes.has(entityType) ||
      (!entityId && !contentUrl) ||
      !reportReasonCodes.has(reasonCode) ||
      !description ||
      description.length > 5000 ||
      supportingDetails?.length > 10000 ||
      !goodFaithDeclared
    )
      return res.status(422).json({
        error:
          'Provide a supported content type, content ID or URL, reason, explanation, and good-faith declaration.',
      });
    if (!reporterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail))
      return res.status(422).json({ error: 'A valid contact email is required.' });
    if (contentUrl) {
      try {
        const url = new URL(contentUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL');
      } catch {
        return res.status(422).json({ error: 'contentUrl must be a valid HTTP(S) URL.' });
      }
    }
    try {
      await ensureTable();
      const reference = reportReference();
      const id = await queries.createContentReport({
        reference,
        reporterUserId: req.user?.id || null,
        reporterEmail,
        entityType,
        entityId,
        contentUrl,
        reasonCode,
        description,
        supportingDetails,
        allegedIllegal,
      });
      return res
        .status(201)
        .json({ id, reference, status: 'submitted', message: 'Your report has been received.' });
    } catch (error) {
      console.error('Content report submission failed:', error.message);
      return res.status(500).json({ error: 'Unable to submit your report.' });
    }
  });
}
