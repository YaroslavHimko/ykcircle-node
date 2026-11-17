export function registerModerationAdministrationRoutes(
  app,
  { authenticate, requirePlatformStaff, ensureTable, queries, requireAdmin, requireRoleManager },
) {
  app.get('/api/admin/contact-messages', authenticate, requirePlatformStaff, async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.contactMessages());
    } catch (error) {
      console.error('Contact message lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to load contact messages.' });
    }
  });
  app.patch('/api/admin/users/:id/role', authenticate, requireAdmin, async (req, res) => {
    if (!['customer', 'organizer', 'venue_owner', 'manager', 'admin'].includes(req.body.role))
      return res.status(400).json({ error: 'Invalid user role.' });
    try {
      await ensureTable();
      if (!(await queries.updateUserRole(req.params.id, req.body.role, req.user.role)))
        return res.status(404).json({ error: 'User not found.' });
      return res.json({ message: 'User role updated.', role: req.body.role });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update user role.' });
    }
  });
  app.get('/api/admin/users', authenticate, requireAdmin, async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.users());
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load users.' });
    }
  });
  app.get('/api/manager/users', authenticate, requireRoleManager, async (_req, res) => {
    try {
      await ensureTable();
      return res.json(await queries.users());
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load users.' });
    }
  });
  app.patch('/api/manager/users/:id/role', authenticate, requireRoleManager, async (req, res) => {
    if (req.body.role !== 'organizer')
      return res.status(400).json({ error: 'Managers can only assign the organizer role.' });
    try {
      await ensureTable();
      if (!(await queries.updateUserRole(req.params.id, 'organizer', req.user.role)))
        return res.status(404).json({ error: 'Customer not found.' });
      return res.json({ message: 'User role updated.', role: 'organizer' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to update user role.' });
    }
  });
  app.get('/api/admin/reports', authenticate, requireAdmin, async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['submitted', 'under_review', 'resolved', 'dismissed'].includes(status))
      return res.status(422).json({ error: 'Invalid report status.' });
    try {
      await ensureTable();
      return res.json(await queries.contentReports(status));
    } catch (error) {
      return res.status(500).json({ error: 'Unable to load reports.' });
    }
  });
  app.patch('/api/admin/reports/:id', authenticate, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body.status || '');
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      !['under_review', 'resolved', 'dismissed'].includes(status)
    )
      return res.status(422).json({ error: 'Invalid report status.' });
    try {
      await ensureTable();
      if (!(await queries.reviewContentReport(id, status, req.user.id)))
        return res.status(404).json({ error: 'Report not found.' });
      await queries.audit(req.user.id, 'content_report_reviewed', 'content_report', id, { status });
      return res.json({ id, status });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to review report.' });
    }
  });
  app.post('/api/admin/moderation/decisions', authenticate, requireAdmin, async (req, res) => {
    const entityType = String(req.body.entityType || '').trim();
    const entityId = String(req.body.entityId || '').trim();
    const action = String(req.body.action || '').trim();
    const reasonCode = String(req.body.reasonCode || '').trim();
    const explanationUser =
      req.body.explanationUser == null ? null : String(req.body.explanationUser).trim();
    if (!entityType || !entityId || !action || !reasonCode || explanationUser?.length > 5000)
      return res.status(422).json({
        error:
          'A content type, content id, action, reason and optional user explanation are required.',
      });
    try {
      await ensureTable();
      const id = await queries.createModerationDecision({
        entityType,
        entityId,
        subjectUserId: Number.isInteger(req.body.subjectUserId) ? req.body.subjectUserId : null,
        action,
        reasonCode,
        explanationInternal:
          req.body.explanationInternal == null ? null : String(req.body.explanationInternal).trim(),
        explanationUser,
        automatedDetection: req.body.automatedDetection === true,
        decidedByUserId: req.user.id,
        appealAvailable: req.body.appealAvailable !== false,
      });
      await queries.audit(req.user.id, 'moderation_decision_created', entityType, entityId, {
        decisionId: id,
        action,
        reasonCode,
      });
      return res.status(201).json({ id });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to record moderation decision.' });
    }
  });
  app.post('/api/appeals', authenticate, async (req, res) => {
    const decisionId = Number(req.body.moderationDecisionId);
    const explanation = String(req.body.explanation || '').trim();
    if (
      !Number.isInteger(decisionId) ||
      decisionId < 1 ||
      !explanation ||
      explanation.length > 5000
    )
      return res.status(422).json({ error: 'A moderation decision and explanation are required.' });
    try {
      await ensureTable();
      const decision = await queries.moderationDecision(decisionId);
      if (
        !decision ||
        !decision.appealAvailable ||
        (decision.subjectUserId && decision.subjectUserId !== req.user.id)
      )
        return res.status(404).json({ error: 'Appeal is unavailable for this decision.' });
      const id = await queries.createModerationAppeal({
        decisionId,
        userId: req.user.id,
        explanation,
      });
      await queries.audit(
        req.user.id,
        'moderation_appeal_created',
        'moderation_decision',
        decisionId,
        { appealId: id },
      );
      return res.status(201).json({ id, status: 'submitted' });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to submit appeal.' });
    }
  });
  app.patch('/api/admin/appeals/:id', authenticate, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body.status || '');
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      !['under_review', 'upheld', 'reversed', 'partially_reversed'].includes(status)
    )
      return res.status(422).json({ error: 'Invalid appeal status.' });
    try {
      await ensureTable();
      if (
        !(await queries.resolveModerationAppeal(
          id,
          req.user.id,
          status,
          req.body.outcome == null ? null : String(req.body.outcome),
          req.body.outcomeReason == null ? null : String(req.body.outcomeReason),
        ))
      )
        return res.status(404).json({ error: 'Appeal not found or already resolved.' });
      await queries.audit(req.user.id, 'moderation_appeal_resolved', 'moderation_appeal', id, {
        status,
      });
      return res.json({ id, status });
    } catch (error) {
      return res.status(500).json({ error: 'Unable to resolve appeal.' });
    }
  });
}
