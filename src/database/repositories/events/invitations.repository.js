import crypto from 'node:crypto';

export class EventsInvitationsRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async createInvitation(eventId, managerId, name, email) {
    const [event] = await this.database.execute(
      'SELECT id, title, description, custom_formatted_address AS location, starts_at AS startsAt, ends_at AS endsAt, timezone FROM events WHERE id = ? AND manager_id = ?',
      [eventId, managerId],
    );
    if (!event[0]) return { error: 'EVENT_NOT_FOUND' };
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    try {
      await this.database.execute(
        'INSERT INTO event_invitations (event_id, manager_id, name, email, token_hash, token_expires_at) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))',
        [eventId, managerId, name, email, tokenHash],
      );
      return { ...event[0], invitationToken: token };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return { error: 'ALREADY_INVITED' };
      throw error;
    }
  }

  async resendInvitation(eventId, invitationId, managerId) {
    const [rows] = await this.database.execute(
      "SELECT i.id AS invitationId, i.name, i.email, e.id, e.title, e.description, e.custom_formatted_address AS location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.timezone FROM event_invitations i JOIN events e ON e.id = i.event_id WHERE i.id = ? AND i.event_id = ? AND i.manager_id = ? AND i.status = 'Pending'",
      [invitationId, eventId, managerId],
    );
    const invitation = rows[0];
    if (!invitation) return null;
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await this.database.execute(
      'UPDATE event_invitations SET token_hash = ?, token_expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?',
      [tokenHash, invitation.invitationId],
    );
    return { ...invitation, invitationToken: token };
  }

  async invitations(eventId, managerId) {
    const [rows] = await this.database.execute(
      'SELECT i.id, i.event_id AS eventId, i.name, i.email, i.status, i.created_at AS createdAt FROM event_invitations i WHERE i.event_id = ? AND i.manager_id = ? ORDER BY i.created_at DESC',
      [eventId, managerId],
    );
    return rows;
  }

  async updateInvitationStatus(id, eventId, managerId, status) {
    const [result] = await this.database.execute(
      'UPDATE event_invitations SET status = ? WHERE id = ? AND event_id = ? AND manager_id = ?',
      [status, id, eventId, managerId],
    );
    return result.affectedRows > 0;
  }

  async respondToInvitation(token, status) {
    if (status === 'Accepted') return this.queries.acceptInvitationAsParticipant(token);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [result] = await this.database.execute(
      "UPDATE event_invitations SET status = ? WHERE token_hash = ? AND token_expires_at > NOW() AND status = 'Pending'",
      [status, tokenHash],
    );
    if (!result.affectedRows) return null;
    const [rows] = await this.database.execute(
      'SELECT id, event_id AS eventId, name, email, status FROM event_invitations WHERE token_hash = ?',
      [tokenHash],
    );
    return rows[0] || null;
  }

  async acceptInvitationAsParticipant(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [rows] = await this.database.execute(
      "SELECT id, event_id AS eventId, name, email FROM event_invitations WHERE token_hash = ? AND token_expires_at > NOW() AND status = 'Pending'",
      [tokenHash],
    );
    const invitation = rows[0];
    if (!invitation) return null;
    const [users] = await this.database.execute(
      'SELECT id, phone FROM users WHERE LOWER(email) = LOWER(?)',
      [invitation.email],
    );
    const userId = users[0]?.id || null;
    const duplicate = await this.queries.existingEventRegistration(
      invitation.eventId,
      userId,
      invitation.email,
    );
    if (duplicate && !(duplicate.source === 'registration' && duplicate.status === 'Withdrawn'))
      return {
        eventId: invitation.eventId,
        participantId: duplicate.source === 'participant' ? duplicate.id : null,
        requiresRegistration: false,
        status: duplicate.status,
        alreadyRegistered: true,
      };
    const paymentStatus =
      (await this.queries.eventFee(invitation.eventId)) > 0 ? 'Payment Required' : 'Not Required';
    if (duplicate)
      await this.database.execute('DELETE FROM event_registrations WHERE id = ?', [duplicate.id]);
    const [participant] = await this.database.execute(
      'INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, payment_status) VALUES (?, ?, ?, ?, ?, ?)',
      [
        invitation.eventId,
        userId,
        invitation.name,
        invitation.email,
        users[0]?.phone || null,
        paymentStatus,
      ],
    );
    await this.database.execute("UPDATE event_invitations SET status = 'Accepted' WHERE id = ?", [
      invitation.id,
    ]);
    await this.database.execute('DELETE FROM event_invitations WHERE id = ?', [invitation.id]);
    return {
      eventId: invitation.eventId,
      participantId: participant.insertId,
      name: invitation.name,
      email: invitation.email,
      requiresRegistration: false,
      status: 'Pending',
      paymentStatus,
    };
  }
}
