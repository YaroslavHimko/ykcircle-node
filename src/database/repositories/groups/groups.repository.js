import crypto from 'node:crypto';

export class GroupsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async createGroup({ organizerId, name, slug, description, visibility }) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        'INSERT INTO event_groups (organizer_id, name, slug, description, visibility) VALUES (?, ?, ?, ?, ?)',
        [organizerId, name, slug, description, visibility],
      );
      await connection.execute(
        "INSERT INTO group_memberships (group_id, user_id, role) VALUES (?, ?, 'owner')",
        [result.insertId, organizerId],
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

  async groupsForViewer(
    userId = null,
    role = null,
    { managedOnly = false, membershipOnly = false } = {},
  ) {
    const privileged = ['manager', 'admin'].includes(role);
    const managedFilter = managedOnly
      ? privileged
        ? 'TRUE'
        : 'g.organizer_id = ?'
      : membershipOnly
        ? 'g.organizer_id = ? OR gm.user_id IS NOT NULL'
        : privileged
          ? 'TRUE'
          : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL";
    const params = privileged && !membershipOnly ? [userId, userId] : [userId, userId, userId];
    const [rows] = await this.database.execute(
      `SELECT g.id, g.organizer_id AS organizerId, g.name, g.slug, g.description, g.cover_image AS coverImage, CASE WHEN g.cover_image IS NULL THEN NULL ELSE CONCAT('/uploads/group-covers/', g.cover_image) END AS coverImageUrl, g.visibility, g.status, g.created_at AS createdAt, g.updated_at AS updatedAt,
      owner.name AS organizerName, COUNT(DISTINCT members.user_id) AS memberCount, gm.role AS membershipRole, group_ratings.ratingAverage, COALESCE(group_ratings.ratedEventCount, 0) AS ratedEventCount,
      IF(gm.user_id IS NULL, FALSE, TRUE) AS isMember, IF(g.organizer_id = ?, TRUE, FALSE) AS isOrganizer
      FROM event_groups g JOIN users owner ON owner.id = g.organizer_id
      LEFT JOIN (SELECT e.group_id, ROUND(AVG(event_averages.ratingAverage), 2) AS ratingAverage, COUNT(*) AS ratedEventCount FROM events e JOIN (SELECT event_id, AVG(rating) AS ratingAverage FROM event_ratings GROUP BY event_id) event_averages ON event_averages.event_id = e.id WHERE e.deleted_at IS NULL GROUP BY e.group_id) group_ratings ON group_ratings.group_id = g.id
      LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active'
      LEFT JOIN group_memberships members ON members.group_id = g.id AND members.status = 'active'
      WHERE ${managedFilter}
      GROUP BY g.id, gm.role, gm.user_id, owner.name, group_ratings.ratingAverage, group_ratings.ratedEventCount ORDER BY g.created_at DESC`,
      params,
    );
    return rows;
  }

  async group(id, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT g.id, g.organizer_id AS organizerId, g.name, g.slug, g.description, g.cover_image AS coverImage, CASE WHEN g.cover_image IS NULL THEN NULL ELSE CONCAT('/uploads/group-covers/', g.cover_image) END AS coverImageUrl, g.visibility, g.status, g.created_at AS createdAt, g.updated_at AS updatedAt,
      owner.name AS organizerName, COUNT(DISTINCT members.user_id) AS memberCount, gm.role AS membershipRole, group_ratings.ratingAverage, COALESCE(group_ratings.ratedEventCount, 0) AS ratedEventCount,
      IF(gm.user_id IS NULL, FALSE, TRUE) AS isMember, IF(g.organizer_id = ?, TRUE, FALSE) AS isOrganizer
      FROM event_groups g JOIN users owner ON owner.id = g.organizer_id
      LEFT JOIN (SELECT e.group_id, ROUND(AVG(event_averages.ratingAverage), 2) AS ratingAverage, COUNT(*) AS ratedEventCount FROM events e JOIN (SELECT event_id, AVG(rating) AS ratingAverage FROM event_ratings GROUP BY event_id) event_averages ON event_averages.event_id = e.id WHERE e.deleted_at IS NULL GROUP BY e.group_id) group_ratings ON group_ratings.group_id = g.id
      LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active'
      LEFT JOIN group_memberships members ON members.group_id = g.id AND members.status = 'active'
      WHERE g.id = ? AND (${privileged ? 'TRUE' : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL"})
      GROUP BY g.id, gm.role, gm.user_id, owner.name, group_ratings.ratingAverage, group_ratings.ratedEventCount`,
      [userId, userId, id, ...(privileged ? [] : [userId])],
    );
    return rows[0] || null;
  }

  async groupEvents(groupId, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const params = privileged ? [groupId] : [groupId, userId];
    const [rows] = await this.database.execute(
      `SELECT e.id, e.manager_id AS managerId, e.group_id AS groupId, e.title, e.short_description AS shortDescription, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.participation_fee AS fee, e.status, e.visibility, e.cover_image AS coverImage, e.cover_image AS coverImageUrl, e.cover_image AS thumbnailUrl, e.created_at AS createdAt, manager.name AS managerName, (SELECT ROUND(AVG(rating), 2) FROM event_ratings WHERE event_id = e.id) AS ratingAverage, (SELECT COUNT(*) FROM event_ratings WHERE event_id = e.id) AS ratingCount
      FROM events e JOIN users manager ON manager.id = e.manager_id
      WHERE e.group_id = ? AND e.deleted_at IS NULL AND (${privileged ? 'TRUE' : "e.manager_id = ? OR e.status = 'Archived' OR (e.status = 'Published' AND e.visibility = 'Public')"}) ORDER BY e.starts_at ASC`,
      params,
    );
    return rows;
  }

  async updateGroup(id, userId, role, data) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(
      `UPDATE event_groups SET name = ?, description = ?, visibility = ? WHERE id = ?${globalAccess ? '' : ' AND organizer_id = ?'}`,
      globalAccess
        ? [data.name, data.description, data.visibility, id]
        : [data.name, data.description, data.visibility, id, userId],
    );
    return result.affectedRows > 0;
  }

  async setGroupCover(id, userId, role, coverImage) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(
      `UPDATE event_groups SET cover_image = ? WHERE id = ?${globalAccess ? '' : ' AND organizer_id = ?'}`,
      globalAccess ? [coverImage, id] : [coverImage, id, userId],
    );
    return result.affectedRows > 0;
  }

  async groupForCover(filename, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT g.id, (g.visibility = 'Public') AS publiclyVisible FROM event_groups g LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active' WHERE g.cover_image = ? AND (${privileged ? 'TRUE' : "g.visibility = 'Public' OR g.organizer_id = ? OR gm.user_id IS NOT NULL"})`,
      privileged ? [userId, filename] : [userId, filename, userId],
    );
    return rows[0] ? { ...rows[0], publiclyVisible: Boolean(rows[0].publiclyVisible) } : null;
  }

  async deleteGroup(id, userId, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [result] = await this.database.execute(
      `DELETE FROM event_groups WHERE id = ?${globalAccess ? '' : ' AND organizer_id = ?'}`,
      globalAccess ? [id] : [id, userId],
    );
    return result.affectedRows > 0;
  }

  async joinGroup(id, userId) {
    const [groups] = await this.database.execute(
      'SELECT id, visibility FROM event_groups WHERE id = ?',
      [id],
    );
    if (!groups[0]) return { error: 'NOT_FOUND' };
    if (groups[0].visibility !== 'Public') return { error: 'PRIVATE' };
    const [result] = await this.database.execute(
      "INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'",
      [id, userId],
    );
    return { joined: result.affectedRows > 0 };
  }

  async leaveGroup(id, userId) {
    const [result] = await this.database.execute(
      "DELETE FROM group_memberships WHERE group_id = ? AND user_id = ? AND role = 'member'",
      [id, userId],
    );
    return result.affectedRows > 0;
  }

  async groupMembers(id, userId, role) {
    const globalAccess = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT gm.user_id AS userId, u.name, u.email, u.profile_picture AS profilePicture, gm.role, gm.joined_at AS joinedAt
      FROM group_memberships gm JOIN event_groups g ON g.id = gm.group_id JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?${globalAccess ? '' : ' AND g.organizer_id = ?'} ORDER BY gm.role = 'owner' DESC, gm.joined_at ASC`,
      globalAccess ? [id] : [id, userId],
    );
    return rows;
  }

  async groupMember(groupId, userId) {
    const [rows] = await this.database.execute(
      'SELECT gm.user_id AS userId, u.name, u.email, u.profile_picture AS profilePicture, gm.role, gm.status, gm.joined_at AS joinedAt FROM group_memberships gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.user_id = ?',
      [groupId, userId],
    );
    return rows[0] || null;
  }

  async addGroupMember(groupId, { userId = null, email = null }) {
    const [groups] = await this.database.execute(
      'SELECT visibility FROM event_groups WHERE id = ?',
      [groupId],
    );
    if (!groups[0]) return { error: 'NOT_FOUND' };
    if (groups[0].visibility === 'Private') return { error: 'PRIVATE' };
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const [users] = await this.database.execute(
      userId
        ? 'SELECT id, isEmailConfirmed FROM users WHERE id = ?'
        : 'SELECT id, isEmailConfirmed FROM users WHERE LOWER(email) = ?',
      [userId || normalizedEmail],
    );
    const user = users[0];
    if (!user) return { error: 'USER_NOT_FOUND' };
    if (!user.isEmailConfirmed) return { error: 'EMAIL_NOT_VERIFIED' };
    const [result] = await this.database.execute(
      "INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'",
      [groupId, user.id],
    );
    return {
      added: result.affectedRows > 0,
      member: await this.queries.groupMember(groupId, user.id),
    };
  }

  async createGroupInvitation(groupId, inviterId, { userId = null, email = null }, tokenHash) {
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const [groups] = await this.database.execute(
      'SELECT id, name, visibility FROM event_groups WHERE id = ?',
      [groupId],
    );
    const group = groups[0];
    if (!group) return { error: 'NOT_FOUND' };
    if (group.visibility !== 'Private') return { error: 'NOT_PRIVATE' };
    const [users] = await this.database.execute(
      userId
        ? 'SELECT id, name, email FROM users WHERE id = ?'
        : 'SELECT id, name, email FROM users WHERE LOWER(email) = ?',
      [userId || normalizedEmail],
    );
    const user = users[0] || null;
    const recipientEmail = (user?.email || normalizedEmail).toLowerCase();
    if (!recipientEmail) return { error: 'USER_NOT_FOUND' };
    const [memberships] = await this.database.execute(
      'SELECT role, status FROM group_memberships WHERE group_id = ? AND user_id = ?',
      [groupId, user?.id || null],
    );
    if (memberships[0]?.status === 'active') return { error: 'ALREADY_MEMBER' };
    await this.database.execute(
      `INSERT INTO group_invitations (group_id, invited_by_user_id, invited_user_id, email, token_hash, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 14 DAY))
      ON DUPLICATE KEY UPDATE invited_by_user_id = VALUES(invited_by_user_id), invited_user_id = VALUES(invited_user_id), token_hash = VALUES(token_hash), status = 'pending', expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP`,
      [groupId, inviterId, user?.id || null, recipientEmail, tokenHash],
    );
    const [invitations] = await this.database.execute(
      'SELECT id, email, expires_at AS expiresAt FROM group_invitations WHERE group_id = ? AND email = ?',
      [groupId, recipientEmail],
    );
    return {
      invitation: invitations[0],
      group,
      recipient: { id: user?.id || null, name: user?.name || null, email: recipientEmail },
    };
  }

  async groupInvitations(groupId) {
    const [rows] = await this.database.execute(
      `SELECT i.id, i.group_id AS groupId, i.invited_user_id AS invitedUserId, COALESCE(u.name, i.email) AS recipientName, i.email AS recipientEmail,
    i.status, i.created_at AS createdAt, i.updated_at AS updatedAt, i.expires_at AS expiresAt, IF(i.expires_at <= NOW() AND i.status = 'pending', TRUE, FALSE) AS isExpired
    FROM group_invitations i LEFT JOIN users u ON u.id = i.invited_user_id WHERE i.group_id = ? ORDER BY i.created_at DESC`,
      [groupId],
    );
    return rows;
  }

  async respondToGroupInvitation(token, action) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT i.id, i.group_id AS groupId, i.invited_user_id AS invitedUserId, i.email, i.status, i.expires_at AS expiresAt, g.name AS groupName
        FROM group_invitations i JOIN event_groups g ON g.id = i.group_id WHERE i.token_hash = ? FOR UPDATE`,
        [tokenHash],
      );
      const invitation = rows[0];
      if (
        !invitation ||
        invitation.status !== 'pending' ||
        new Date(invitation.expiresAt).getTime() <= Date.now()
      ) {
        await connection.rollback();
        return { error: 'INVALID' };
      }
      if (action === 'decline') {
        await connection.execute("UPDATE group_invitations SET status = 'declined' WHERE id = ?", [
          invitation.id,
        ]);
        await connection.commit();
        return { status: 'declined', groupId: invitation.groupId, groupName: invitation.groupName };
      }
      const [users] = await connection.execute(
        'SELECT id, name, isEmailConfirmed FROM users WHERE LOWER(email) = LOWER(?) FOR UPDATE',
        [invitation.email],
      );
      const user = users[0];
      if (!user) {
        await connection.rollback();
        return { error: 'ACCOUNT_REQUIRED', email: invitation.email };
      }
      if (!user.isEmailConfirmed) {
        await connection.rollback();
        return { error: 'EMAIL_NOT_VERIFIED' };
      }
      await connection.execute(
        "INSERT INTO group_memberships (group_id, user_id, role, status) VALUES (?, ?, 'member', 'active') ON DUPLICATE KEY UPDATE status = 'active'",
        [invitation.groupId, user.id],
      );
      await connection.execute(
        "UPDATE group_invitations SET status = 'accepted', invited_user_id = ? WHERE id = ?",
        [user.id, invitation.id],
      );
      await connection.commit();
      return {
        status: 'accepted',
        groupId: invitation.groupId,
        groupName: invitation.groupName,
        userId: user.id,
        name: user.name,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async removeGroupMember(groupId, userId) {
    const member = await this.queries.groupMember(groupId, userId);
    if (!member) return { error: 'NOT_FOUND' };
    if (member.role === 'owner') return { error: 'OWNER' };
    const [result] = await this.database.execute(
      "DELETE FROM group_memberships WHERE group_id = ? AND user_id = ? AND role = 'member'",
      [groupId, userId],
    );
    return result.affectedRows ? { removed: true } : { error: 'NOT_FOUND' };
  }

  async canManageGroup(id, userId, role) {
    if (['manager', 'admin'].includes(role)) {
      const [rows] = await this.database.execute('SELECT id FROM event_groups WHERE id = ?', [id]);
      return rows.length > 0;
    }
    const [rows] = await this.database.execute(
      'SELECT id FROM event_groups WHERE id = ? AND organizer_id = ?',
      [id, userId],
    );
    return rows.length > 0;
  }

  async groupExists(id) {
    const [rows] = await this.database.execute('SELECT id FROM event_groups WHERE id = ?', [id]);
    return rows.length > 0;
  }

  async pendingGroupEventNotifications(eventId) {
    const [rows] = await this.database.execute(
      `SELECT u.id AS userId, u.name, u.email, g.id AS groupId, g.name AS groupName, e.id AS eventId, e.title, e.brand_name AS brandName, e.logo_image AS logoImage, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone
      FROM events e JOIN event_groups g ON g.id = e.group_id JOIN group_memberships gm ON gm.group_id = g.id AND gm.role = 'member' AND gm.status = 'active' JOIN users u ON u.id = gm.user_id
      LEFT JOIN group_event_notifications n ON n.event_id = e.id AND n.user_id = u.id
      WHERE e.id = ? AND n.user_id IS NULL`,
      [eventId],
    );
    return rows;
  }

  async claimGroupEventNotification(eventId, userId) {
    const [result] = await this.database.execute(
      'INSERT IGNORE INTO group_event_notifications (event_id, user_id) VALUES (?, ?)',
      [eventId, userId],
    );
    return result.affectedRows > 0;
  }

  async releaseGroupEventNotification(eventId, userId) {
    await this.database.execute(
      'DELETE FROM group_event_notifications WHERE event_id = ? AND user_id = ?',
      [eventId, userId],
    );
  }

  async groupForEvent(eventId) {
    const [rows] = await this.database.execute(
      'SELECT e.group_id AS groupId, g.name AS groupName FROM events e LEFT JOIN event_groups g ON g.id = e.group_id WHERE e.id = ?',
      [eventId],
    );
    return rows[0] || null;
  }
}
