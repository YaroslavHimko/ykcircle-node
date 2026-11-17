export class LegalRepository {
  constructor({ database }) {
    this.database = database;
  }
  async ensureLegalDocumentVersion(document) {
    const documentType = document.documentType || document.slug;
    await this.database.execute(
      'UPDATE legal_document_versions SET is_current = FALSE WHERE document_type = ? AND version <> ?',
      [documentType, document.version],
    );
    await this.database.execute(
      `INSERT INTO legal_document_versions (document_type, version, published_at, content_hash, requires_reacceptance, is_current)
      VALUES (?, ?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE published_at = VALUES(published_at), content_hash = VALUES(content_hash), requires_reacceptance = VALUES(requires_reacceptance), is_current = TRUE`,
      [
        documentType,
        document.version,
        document.lastUpdated ? new Date(document.lastUpdated) : new Date(),
        document.contentHash,
        document.requiresReacceptance === true,
      ],
    );
  }

  async recordLegalAcceptance(
    userId,
    document,
    { source = 'account', contextType = null, contextId = null, organizationId = null } = {},
  ) {
    const documentType = document.documentType || document.slug;
    const normalizedContextType = contextType == null ? null : String(contextType).trim() || null;
    const normalizedContextId = contextId == null ? null : String(contextId).trim() || null;
    const normalizedOrganizationId =
      Number.isInteger(Number(organizationId)) && Number(organizationId) > 0
        ? Number(organizationId)
        : null;
    const [existing] = await this.database.execute(
      `SELECT id, accepted_at AS acceptedAt FROM user_legal_acceptances
      WHERE user_id = ? AND document_type = ? AND version = ?
      AND context_type <=> ? AND context_id <=> ? AND organization_id <=> ?
      ORDER BY accepted_at DESC LIMIT 1`,
      [
        userId,
        documentType,
        document.version,
        normalizedContextType,
        normalizedContextId,
        normalizedOrganizationId,
      ],
    );
    if (existing[0])
      return { id: existing[0].id, acceptedAt: existing[0].acceptedAt, created: false };
    const [result] = await this.database.execute(
      `INSERT INTO user_legal_acceptances
      (user_id, document_type, version, source, context_type, context_id, organization_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        documentType,
        document.version,
        source,
        normalizedContextType,
        normalizedContextId,
        normalizedOrganizationId,
      ],
    );
    return { id: result.insertId, acceptedAt: new Date(), created: true };
  }

  async audit(actorUserId, eventType, entityType = null, entityId = null, metadata = null) {
    await this.database.execute(
      'INSERT INTO audit_log (actor_user_id, event_type, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)',
      [actorUserId, eventType, entityType, entityId == null ? null : String(entityId), metadata],
    );
  }
}
