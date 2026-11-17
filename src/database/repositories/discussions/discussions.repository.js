export class DiscussionsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  forumTables(scope) {
    const tables = {
      group: {
        threads: 'group_forum_threads',
        messages: 'group_forum_messages',
        owner: 'group_id',
      },
      event: {
        threads: 'event_forum_threads',
        messages: 'event_forum_messages',
        owner: 'event_id',
      },
    };
    if (!tables[scope]) throw new Error('Invalid forum scope.');
    return tables[scope];
  }

  async forumThreads(scope, ownerId, userId = null) {
    const table = this.queries.forumTables(scope);
    const [rows] = await this.database.execute(
      `SELECT t.id, t.${table.owner} AS ownerId, t.author_user_id AS authorUserId, t.title, t.status, t.created_at AS createdAt, t.updated_at AS updatedAt, u.name AS authorName, u.profile_picture AS authorProfilePicture, COUNT(m.id) AS messageCount,
    SUM(CASE WHEN m.author_user_id <> ? AND m.id > COALESCE(read_state.last_read_message_id, 0) THEN 1 ELSE 0 END) AS unreadCount
    FROM ${table.threads} t JOIN users u ON u.id = t.author_user_id LEFT JOIN forum_thread_reads read_state ON read_state.scope = ? AND read_state.thread_id = t.id AND read_state.user_id = ? LEFT JOIN ${table.messages} m ON m.thread_id = t.id WHERE t.${table.owner} = ? AND t.status <> 'removed' GROUP BY t.id, u.name, u.profile_picture, read_state.last_read_message_id ORDER BY t.updated_at DESC`,
      [userId, scope, userId, ownerId],
    );
    return rows;
  }

  async forumThread(scope, ownerId, threadId) {
    const table = this.queries.forumTables(scope);
    const [rows] = await this.database.execute(
      `SELECT id, ${table.owner} AS ownerId, author_user_id AS authorUserId, title, status FROM ${table.threads} WHERE id = ? AND ${table.owner} = ?`,
      [threadId, ownerId],
    );
    return rows[0] || null;
  }

  async createForumThread(scope, ownerId, authorUserId, title, body) {
    const table = this.queries.forumTables(scope);
    const [result] = await this.database.execute(
      `INSERT INTO ${table.threads} (${table.owner}, author_user_id, title) VALUES (?, ?, ?)`,
      [ownerId, authorUserId, title],
    );
    await this.database.execute(
      `INSERT INTO ${table.messages} (thread_id, author_user_id, body) VALUES (?, ?, ?)`,
      [result.insertId, authorUserId, body],
    );
    return result.insertId;
  }

  async forumMessages(scope, threadId) {
    const table = this.queries.forumTables(scope);
    const [rows] = await this.database.execute(
      `SELECT m.id, m.thread_id AS threadId, m.author_user_id AS authorUserId, m.body, m.created_at AS createdAt, u.name AS authorName, u.profile_picture AS authorProfilePicture FROM ${table.messages} m JOIN users u ON u.id = m.author_user_id WHERE m.thread_id = ? ORDER BY m.id ASC`,
      [threadId],
    );
    return rows;
  }

  async addForumMessage(scope, threadId, authorUserId, body) {
    const table = this.queries.forumTables(scope);
    const [result] = await this.database.execute(
      `INSERT INTO ${table.messages} (thread_id, author_user_id, body) VALUES (?, ?, ?)`,
      [threadId, authorUserId, body],
    );
    await this.database.execute(
      `UPDATE ${table.threads} SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [threadId],
    );
    return result.insertId;
  }

  async markForumThreadRead(scope, threadId, userId, lastMessageId) {
    this.queries.forumTables(scope);
    if (!lastMessageId) return;
    await this.database.execute(
      'INSERT INTO forum_thread_reads (scope, thread_id, user_id, last_read_message_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_read_message_id = GREATEST(last_read_message_id, VALUES(last_read_message_id)), read_at = CURRENT_TIMESTAMP',
      [scope, threadId, userId, lastMessageId],
    );
  }

  async setForumThreadStatus(scope, threadId, status) {
    const table = this.queries.forumTables(scope);
    const [result] = await this.database.execute(
      `UPDATE ${table.threads} SET status = ? WHERE id = ?`,
      [status, threadId],
    );
    return result.affectedRows > 0;
  }

  async groupForumAccess(groupId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT g.id, g.organizer_id AS organizerId, gm.user_id AS memberUserId FROM event_groups g LEFT JOIN group_memberships gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active' WHERE g.id = ?`,
      [userId, groupId],
    );
    const group = rows[0];
    return Boolean(group && (privileged || group.organizerId === userId || group.memberUserId));
  }

  async eventForumAccess(eventId, userId = null, role = null) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT e.id, e.manager_id AS managerId, e.status, e.visibility,
      EXISTS(SELECT 1 FROM event_registrations r WHERE r.event_id = e.id AND r.user_id = ? AND r.status IN ('Pending', 'Confirmed')) AS isRegistered,
      EXISTS(SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.user_id = ?) AS isParticipant
      FROM events e WHERE e.id = ? AND e.deleted_at IS NULL`,
      [userId, userId, eventId],
    );
    const event = rows[0];
    if (!event) return false;
    return (
      privileged ||
      event.managerId === userId ||
      (event.status === 'Published' && event.visibility === 'Public') ||
      (Boolean(userId) && (Number(event.isRegistered) === 1 || Number(event.isParticipant) === 1))
    );
  }

  async canManageEventForum(eventId, userId, role) {
    const privileged = ['manager', 'admin'].includes(role);
    const [rows] = await this.database.execute(
      `SELECT id FROM events WHERE id = ? AND deleted_at IS NULL${privileged ? '' : ' AND manager_id = ?'}`,
      privileged ? [eventId] : [eventId, userId],
    );
    return rows.length > 0;
  }
}
