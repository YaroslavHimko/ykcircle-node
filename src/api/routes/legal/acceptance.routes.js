import { legalDocument, legalReadiness } from '../../../services/legal/legal-documents.js';

export function registerLegalAcceptanceRoutes(app, { authenticate, config, ensureTable, queries }) {
  app.get('/api/legal-readiness', authenticate, async (req, res) => {
    if (!['manager', 'admin'].includes(req.user.role))
      return res.status(403).json({ error: 'Manager access is required.' });
    return res.json(await legalReadiness(config));
  });
  app.post('/api/legal-documents/:slug/accept', authenticate, async (req, res) => {
    const document = await legalDocument(req.params.slug, config);
    if (!document) return res.status(404).json({ error: 'Legal document not found.' });
    if (req.body?.accepted !== true)
      return res.status(422).json({ error: 'You must explicitly confirm acceptance.' });
    const contextType = req.body?.contextType == null ? null : String(req.body.contextType).trim();
    const contextId = req.body?.contextId == null ? null : String(req.body.contextId).trim();
    const organizationId =
      req.body?.organizationId == null ? null : Number(req.body.organizationId);
    const allowedContexts = new Set([
      'registration',
      'organization',
      'event',
      'venue',
      'booking',
      'platform_order',
      'subscription',
    ]);
    if (contextType && !allowedContexts.has(contextType))
      return res.status(422).json({ error: 'Legal acceptance context is invalid.' });
    if (organizationId != null && (!Number.isInteger(organizationId) || organizationId < 1))
      return res.status(422).json({ error: 'Organization context is invalid.' });
    try {
      await ensureTable();
      if (organizationId != null && !['manager', 'admin'].includes(req.user.role)) {
        const membership = await queries.organizationMember(organizationId, req.user.id);
        if (!membership || !['owner', 'admin', 'manager'].includes(membership.role))
          return res
            .status(403)
            .json({ error: 'You are not authorized to accept terms for this organization.' });
      }
      const acceptance = await queries.recordLegalAcceptance(req.user.id, document, {
        source: 'account',
        contextType,
        contextId,
        organizationId,
      });
      await queries.audit(
        req.user.id,
        'legal_document_accepted',
        'legal_document',
        document.documentType,
        JSON.stringify({
          version: document.version,
          contextType,
          contextId,
          organizationId,
          created: acceptance.created,
        }),
      );
      return res.status(acceptance.created ? 201 : 200).json({
        documentType: document.documentType,
        version: document.version,
        acceptedAt: acceptance.acceptedAt,
        created: acceptance.created,
      });
    } catch (error) {
      console.error('Legal acceptance failed:', error.message);
      return res.status(500).json({ error: 'Unable to record legal acceptance.' });
    }
  });
}
