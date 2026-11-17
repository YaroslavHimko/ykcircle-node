import { utcTimestamp } from '../../../utils/serialization.js';
export class TicketsCheckInRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async isEventRepresentative(eventId, userId, database = this.database) {
    const [rows] = await database.execute(
      `SELECT r.user_id FROM event_representatives r
      JOIN users u ON u.id=r.user_id AND u.isEmailConfirmed=TRUE
      WHERE r.event_id=? AND r.user_id=?`,
      [eventId, userId],
    );
    return rows.length > 0;
  }

  async representativeEvents(userId) {
    const [rows] = await this.database.execute(
      `SELECT e.id, e.title, e.starts_at AS startsAt, e.timezone, e.status
      FROM event_representatives r JOIN events e ON e.id=r.event_id
      JOIN users u ON u.id=r.user_id AND u.isEmailConfirmed=TRUE
      WHERE r.user_id=? AND e.deleted_at IS NULL AND e.status IN ('Published','Completed') ORDER BY e.starts_at DESC`,
      [userId],
    );
    return rows.map((event) => ({ ...event, accessRole: 'representative' }));
  }

  async eventCheckInContext(eventId, userId, role) {
    const [events] = await this.database.execute(
      `SELECT id, manager_id AS managerId, title, starts_at AS startsAt, timezone, status
      FROM events WHERE id=? AND deleted_at IS NULL`,
      [eventId],
    );
    const event = events[0];
    if (!event) return null;
    const fullAccess =
      ['manager', 'admin'].includes(role) || Number(event.managerId) === Number(userId);
    if (
      !fullAccess &&
      (!['Published', 'Completed'].includes(event.status) ||
        !(await this.queries.isEventRepresentative(eventId, userId)))
    )
      return null;
    return {
      id: event.id,
      title: event.title,
      startsAt: utcTimestamp(event.startsAt),
      timezone: event.timezone,
      status: event.status,
      accessRole: fullAccess ? 'organizer' : 'representative',
    };
  }

  async manageEventRepresentatives(
    eventId,
    actorId,
    role,
    { action = 'list', email, userId } = {},
  ) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const reject = async (error) => {
        await connection.rollback();
        return { error };
      };
      // Use the same event lock as check-in so revocation and admission are ordered.
      const [events] = await connection.execute(
        'SELECT id, manager_id AS managerId FROM events WHERE id=? AND deleted_at IS NULL FOR UPDATE',
        [eventId],
      );
      if (
        !events[0] ||
        (!['manager', 'admin'].includes(role) && Number(events[0].managerId) !== Number(actorId))
      )
        return await reject('EVENT_NOT_MANAGED');
      let alreadyAssigned = false;
      if (action === 'add') {
        const [users] = await connection.execute(
          'SELECT id, role, isEmailConfirmed FROM users WHERE LOWER(email)=? FOR UPDATE',
          [email],
        );
        const user = users[0];
        if (!user || !user.isEmailConfirmed) return await reject('VERIFIED_ACCOUNT_REQUIRED');
        if (
          Number(user.id) === Number(events[0].managerId) ||
          ['manager', 'admin'].includes(user.role)
        )
          return await reject('ALREADY_MANAGER');
        const [existing] = await connection.execute(
          'SELECT user_id FROM event_representatives WHERE event_id=? AND user_id=?',
          [eventId, user.id],
        );
        alreadyAssigned = existing.length > 0;
        if (!alreadyAssigned)
          await connection.execute(
            'INSERT INTO event_representatives (event_id, user_id, assigned_by_user_id) VALUES (?, ?, ?)',
            [eventId, user.id, actorId],
          );
      } else if (action === 'remove') {
        await connection.execute(
          'DELETE FROM event_representatives WHERE event_id=? AND user_id=?',
          [eventId, userId],
        );
      }
      const [representatives] = await connection.execute(
        `SELECT r.user_id AS userId, u.name, u.email, r.created_at AS assignedAt
        FROM event_representatives r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.created_at, r.user_id`,
        [eventId],
      );
      await connection.commit();
      return {
        representatives: representatives.map((user) => ({ ...user, role: 'representative' })),
        alreadyAssigned,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async checkInTicket(eventId, userId, role, code) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const reject = async (error) => {
        await connection.rollback();
        return { error };
      };
      // Serialize check-ins for this event, including different tickets belonging
      // to the same purchaser. Authorization and all attendance writes are atomic.
      const [events] = await connection.execute(
        'SELECT id, manager_id AS managerId, status FROM events WHERE id=? AND deleted_at IS NULL FOR UPDATE',
        [eventId],
      );
      const event = events[0];
      if (!event) return await reject('EVENT_NOT_MANAGED');
      const fullAccess =
        ['manager', 'admin'].includes(role) || Number(event.managerId) === Number(userId);
      if (!fullAccess && !(await this.queries.isEventRepresentative(eventId, userId, connection)))
        return await reject('EVENT_NOT_MANAGED');
      if (!['Published', 'Completed'].includes(event.status)) return await reject('EVENT_NOT_OPEN');
      const [tickets] = await connection.execute(
        `SELECT t.id, t.code, t.checked_in_at AS checkedInAt,
        o.id AS orderId, o.attendee_user_id AS attendeeUserId, o.attendee_email AS attendeeEmail,
        o.payment_status AS paymentStatus, o.test_mode AS testMode
        FROM issued_tickets t JOIN ticket_orders o ON o.id=t.ticket_order_id
        WHERE t.code=? AND o.event_id=? FOR UPDATE`,
        [code, eventId],
      );
      const ticket = tickets[0];
      if (!ticket) return await reject('TICKET_NOT_FOUND');
      if (ticket.paymentStatus !== 'paid') return await reject('TICKET_NOT_PAID');
      if (!ticket.attendeeUserId) return await reject('ATTENDEE_UNAVAILABLE');
      const [users] = await connection.execute(
        'SELECT id, name, email, phone, profile_picture AS profilePicture FROM users WHERE id=?',
        [ticket.attendeeUserId],
      );
      if (!users[0]) return await reject('ATTENDEE_UNAVAILABLE');
      const [registrations] = await connection.execute(
        'SELECT id, status FROM event_registrations WHERE event_id=? AND user_id=? FOR UPDATE',
        [eventId, ticket.attendeeUserId],
      );
      if (
        registrations.some((registration) =>
          ['Cancelled', 'Declined', 'Withdrawn'].includes(registration.status),
        )
      )
        return await reject('REGISTRATION_INACTIVE');
      const attendee = users[0];
      if (!ticket.checkedInAt) {
        await connection.execute(
          `INSERT INTO event_participants (event_id, user_id, participant_name, participant_email, participant_phone, status, payment_status)
          VALUES (?, ?, ?, ?, ?, 'Attended', 'Paid') ON DUPLICATE KEY UPDATE status='Attended', payment_status='Paid'`,
          [
            eventId,
            attendee.id,
            attendee.name || ticket.attendeeEmail || 'Ticket holder',
            ticket.attendeeEmail || attendee.email,
            attendee.phone,
          ],
        );
        await connection.execute(
          "UPDATE event_registrations SET status='Attended', payment_status='Paid' WHERE event_id=? AND user_id=?",
          [eventId, attendee.id],
        );
        await connection.execute(
          'UPDATE issued_tickets SET checked_in_at=UTC_TIMESTAMP(), checked_in_by_user_id=? WHERE id=? AND checked_in_at IS NULL',
          [userId, ticket.id],
        );
      }
      const [participants] = await connection.execute(
        `SELECT id, user_id AS userId, participant_name AS name, participant_email AS email,
        participant_phone AS phone, status, payment_status AS paymentStatus, joined_at AS joinedAt FROM event_participants WHERE event_id=? AND user_id=?`,
        [eventId, attendee.id],
      );
      const [saved] = await connection.execute(
        'SELECT checked_in_at AS checkedInAt FROM issued_tickets WHERE id=?',
        [ticket.id],
      );
      await connection.commit();
      return {
        ticketId: ticket.id,
        code: ticket.code,
        eventId,
        alreadyCheckedIn: Boolean(ticket.checkedInAt),
        checkedInAt: utcTimestamp(saved[0].checkedInAt),
        testMode: Boolean(ticket.testMode),
        participant: participants[0]
          ? fullAccess
            ? { ...participants[0], profilePicture: attendee.profilePicture }
            : { id: participants[0].id, name: participants[0].name, status: participants[0].status }
          : null,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
