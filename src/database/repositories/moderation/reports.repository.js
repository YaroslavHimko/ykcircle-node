export class ModerationReportsRepository {
  constructor({ database }) {
    this.database = database;
  }
  async createContentReport(report) {
    const [result] = await this.database.execute(
      `INSERT INTO content_reports
        (reference, reporter_user_id, reporter_email, entity_type, entity_id, content_url, reason_code, description, supporting_details, alleged_illegal, good_faith_declared)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.reference,
        report.reporterUserId,
        report.reporterEmail,
        report.entityType,
        report.entityId,
        report.contentUrl,
        report.reasonCode,
        report.description,
        report.supportingDetails,
        report.allegedIllegal,
        true,
      ],
    );
    return result.insertId;
  }

  async contentReports(status = null) {
    const [rows] = await this.database.execute(
      `SELECT r.id, r.reference, r.reporter_user_id AS reporterUserId, r.reporter_email AS reporterEmail, r.entity_type AS entityType, r.entity_id AS entityId, r.content_url AS contentUrl, r.reason_code AS reasonCode, r.description, r.alleged_illegal AS allegedIllegal, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt, r.reviewed_by_user_id AS reviewedByUserId
      FROM content_reports r${status ? ' WHERE r.status = ?' : ''} ORDER BY r.created_at DESC`,
      status ? [status] : [],
    );
    return rows;
  }

  async reviewContentReport(id, status, reviewerUserId) {
    const [result] = await this.database.execute(
      'UPDATE content_reports SET status = ?, reviewed_at = NOW(), reviewed_by_user_id = ? WHERE id = ?',
      [status, reviewerUserId, id],
    );
    return result.affectedRows > 0;
  }
}
