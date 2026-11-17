export class OrganizationsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async organization(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT o.id, o.name, o.slug, o.description, o.website_url AS websiteUrl, o.phone, o.contact_email AS contactEmail, o.is_active AS isActive, om.role AS membershipRole FROM organizations o LEFT JOIN organization_members om ON om.organization_id = o.id AND om.user_id = ? WHERE o.id = ? AND (${privileged ? 'TRUE' : 'o.is_active = TRUE OR om.user_id IS NOT NULL'})`,
      [userId, id],
    );
    return rows[0] ? { ...rows[0], isActive: Boolean(rows[0].isActive) } : null;
  }

  async createOrganization(ownerUserId, data) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        'INSERT INTO organizations (name, slug, description, website_url, phone, contact_email) VALUES (?, ?, ?, ?, ?, ?)',
        [data.name, data.slug, data.description, data.websiteUrl, data.phone, data.contactEmail],
      );
      await connection.execute(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'owner')",
        [result.insertId, ownerUserId],
      );
      await connection.commit();
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async organizationMember(organizationId, userId) {
    const [rows] = await this.database.execute(
      'SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?',
      [organizationId, userId],
    );
    return rows[0] || null;
  }

  async updateOrganization(organizationId, userId, role, data) {
    if (!(await this.queries.canManageOrganization(organizationId, userId, role))) return false;
    await this.database.execute(
      'UPDATE organizations SET name = ?, slug = ?, description = ?, website_url = ?, phone = ?, contact_email = ? WHERE id = ?',
      [
        data.name,
        data.slug,
        data.description,
        data.websiteUrl,
        data.phone,
        data.contactEmail,
        organizationId,
      ],
    );
    // An unchanged update is still successful; return the saved representation.
    return (await this.queries.organization(organizationId, userId, role)) || false;
  }

  async setOrganizationMember(organizationId, actorUserId, actorRole, userId, membershipRole) {
    if (!['manager', 'admin'].includes(actorRole)) {
      const actor = await this.queries.organizationMember(organizationId, actorUserId);
      if (!actor || !['owner', 'admin'].includes(actor.role)) return false;
    }
    const [result] = await this.database.execute(
      'INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
      [organizationId, userId, membershipRole],
    );
    return result.affectedRows > 0;
  }

  async canManageOrganization(organizationId, userId, role) {
    if (['manager', 'admin'].includes(role)) return true;
    const member = await this.queries.organizationMember(organizationId, userId);
    return Boolean(member && ['owner', 'admin', 'manager'].includes(member.role));
  }

  async managedOrganizations(userId, role) {
    const [rows] = await this.database.execute(
      `SELECT o.id, o.name, o.slug, o.description, o.website_url AS websiteUrl,
      o.phone, o.contact_email AS contactEmail, member.role AS membershipRole
      FROM organizations o LEFT JOIN organization_members member ON member.organization_id=o.id AND member.user_id=?
      WHERE ${['manager', 'admin'].includes(role) ? 'TRUE' : "member.role IN ('owner','admin','manager')"}
      ORDER BY o.name`,
      [userId],
    );
    return rows;
  }
}
