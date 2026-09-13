import crypto from 'node:crypto';

const fail = (message) => { throw new Error(message); };

// Shared by signed webhooks, the buyer's return page, and the recovery worker.
// None of these callers can mark an order paid without retrieving it from Stripe.
export class TicketSales {
  constructor({ queries, stripe, emailService, siteUrl }) {
    Object.assign(this, { queries, stripe, emailService, siteUrl });
    this.database = queries.database;
  }

  async checkoutOrder(id) {
    const [rows] = await this.database.execute(`SELECT o.id, o.event_id AS eventId, o.attendee_user_id AS attendeeUserId,
      o.checkout_session_id AS checkoutSessionId, o.payment_status AS paymentStatus, o.test_mode AS testMode,
      o.created_at AS createdAt, a.provider_account_id AS providerAccountId FROM ticket_orders o JOIN payment_accounts a ON a.id=o.payment_account_id WHERE o.id=?`, [id]);
    return rows[0] || null;
  }

  async attachCheckout(orderId, session) {
    await this.database.execute(`UPDATE ticket_orders SET checkout_session_id=?, provider_payment_id=COALESCE(provider_payment_id,?),
      checkout_expires_at=FROM_UNIXTIME(?), test_mode=? WHERE id=? AND (checkout_session_id IS NULL OR checkout_session_id=?)`,
    [session.id, session.id, session.expires_at, !session.livemode, orderId, session.id]);
  }

  async confirm(orderId, sessionId = null, connectedAccountId = null) {
    const order = await this.checkoutOrder(orderId);
    if (!order) fail('Ticket order not found.');
    if (connectedAccountId && connectedAccountId !== order.providerAccountId) fail('Ticket payment account mismatch.');
    const requestedSession = sessionId || order.checkoutSessionId;
    if (!requestedSession) return;
    if (order.checkoutSessionId && order.checkoutSessionId !== requestedSession) fail('Ticket checkout session mismatch.');
    const session = await this.stripe.checkoutSession(requestedSession, order.providerAccountId);
    await this.fulfill(order, session);
    // Fulfillment commits before SMTP; retries deliver the same ticket codes.
    await this.deliver(orderId);
  }

  async fulfill(context, session) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT o.*, a.provider_account_id AS providerAccountId FROM ticket_orders o
        JOIN payment_accounts a ON a.id=o.payment_account_id WHERE o.id=? FOR UPDATE`, [context.id]);
      const order = rows[0];
      if (!order || context.providerAccountId !== order.providerAccountId ||
        session.metadata?.ticketOrderId !== String(order.id) || session.client_reference_id !== String(order.id) ||
        (order.checkout_session_id && order.checkout_session_id !== session.id) ||
        typeof session.livemode !== 'boolean' || session.livemode === this.stripe.testMode() ||
        session.mode !== 'payment' || session.currency?.toUpperCase() !== order.currency ||
        session.amount_total !== Math.round(Number(order.total_amount) * 100)) fail('Stripe payment does not match this ticket order.');
      if (session.status === 'expired' && order.payment_status === 'pending') {
        await connection.execute("UPDATE ticket_orders SET payment_status='cancelled' WHERE id=?", [order.id]);
      } else if (session.status === 'complete' && session.payment_status === 'paid' && order.payment_status === 'pending') {
        const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        if (!paymentId) fail('Stripe did not return a payment reference.');
        await connection.execute(`UPDATE ticket_orders SET payment_status='paid', paid_at=NOW(), provider_payment_id=?,
          checkout_session_id=?, test_mode=? WHERE id=?`, [paymentId, session.id, !session.livemode, order.id]);
        const [items] = await connection.execute('SELECT id, ticket_type_id AS ticketTypeId, quantity FROM ticket_order_items WHERE ticket_order_id=? ORDER BY ticket_type_id', [order.id]);
        for (const item of items) {
          await connection.execute('UPDATE event_ticket_types SET quantity_sold=quantity_sold+? WHERE id=?', [item.quantity, item.ticketTypeId]);
          for (let ordinal = 1; ordinal <= item.quantity; ordinal++) {
            await connection.execute('INSERT INTO issued_tickets (ticket_order_id,ticket_order_item_id,ordinal,code) VALUES (?,?,?,?)',
              [order.id, item.id, ordinal, `YK-${crypto.randomBytes(16).toString('hex').toUpperCase()}`]);
          }
        }
        if (order.attendee_user_id && order.event_id) {
          await connection.execute(`INSERT INTO event_registrations (event_id,user_id,attendee_email,status,payment_status)
            VALUES (?,?,?,'Confirmed','Paid') ON DUPLICATE KEY UPDATE status='Confirmed',payment_status='Paid'`, [order.event_id, order.attendee_user_id, order.attendee_email]);
        }
        await connection.execute('INSERT IGNORE INTO ticket_email_deliveries (ticket_order_id) VALUES (?)', [order.id]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }

  async details(order) {
    const [tickets] = await this.database.execute(`SELECT t.id,t.code,item.ticket_type_snapshot_json AS ticketType FROM issued_tickets t
      JOIN ticket_order_items item ON item.id=t.ticket_order_item_id WHERE t.ticket_order_id=? ORDER BY t.id`, [order.id]);
    const [events] = await this.database.execute(`SELECT e.starts_at AS startsAt,e.ends_at AS endsAt,e.timezone,
      COALESCE(v.name,e.custom_formatted_address,e.online_platform) AS location FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE e.id=?`, [order.eventId]);
    const [deliveries] = await this.database.execute('SELECT sent_at AS sentAt FROM ticket_email_deliveries WHERE ticket_order_id=?', [order.id]);
    return { ...order, testMode: Boolean(order.testMode), event: events[0] || {}, emailStatus: deliveries[0]?.sentAt ? 'sent' : 'pending',
      tickets: tickets.map((ticket) => ({ id: ticket.id, code: ticket.code, name: (typeof ticket.ticketType === 'string' ? JSON.parse(ticket.ticketType) : ticket.ticketType)?.name || 'Admission', valid: order.paymentStatus === 'paid' })) };
  }

  async deliver(orderId) {
    const lock = crypto.randomUUID();
    const [claim] = await this.database.execute(`UPDATE ticket_email_deliveries SET locked_until=DATE_ADD(NOW(),INTERVAL 5 MINUTE),lock_token=?,attempts=attempts+1
      WHERE ticket_order_id=? AND sent_at IS NULL AND next_attempt_at<=NOW() AND (locked_until IS NULL OR locked_until<NOW())`, [lock, orderId]);
    if (!claim.affectedRows) return;
    try {
      const order = await this.queries.ticketOrder(orderId, null, 'admin');
      if (!order || order.paymentStatus !== 'paid') {
        await this.database.execute('UPDATE ticket_email_deliveries SET next_attempt_at=DATE_ADD(NOW(),INTERVAL 1 DAY),locked_until=NULL,lock_token=NULL WHERE ticket_order_id=? AND lock_token=?', [orderId, lock]);
        return;
      }
      await this.emailService.sendTickets(await this.details(order), `${this.siteUrl}/tickets/${orderId}`);
      await this.database.execute('UPDATE ticket_email_deliveries SET sent_at=NOW(),locked_until=NULL,lock_token=NULL,last_error=NULL WHERE ticket_order_id=? AND lock_token=?', [orderId, lock]);
    } catch (error) {
      await this.database.execute(`UPDATE ticket_email_deliveries SET locked_until=NULL,lock_token=NULL,last_error=?,
        next_attempt_at=DATE_ADD(NOW(),INTERVAL 5 MINUTE) WHERE ticket_order_id=? AND lock_token=?`, [String(error.message).slice(0, 500), orderId, lock]);
      console.error('Ticket email queued for retry:', orderId, error.code || 'SMTP_ERROR');
    }
  }

  async recover() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      if (this.stripe.configured()) {
        const [pending] = await this.database.execute(`SELECT id FROM ticket_orders WHERE payment_status='pending'
          AND checkout_session_id IS NOT NULL AND created_at<DATE_SUB(NOW(),INTERVAL 1 MINUTE) ORDER BY updated_at LIMIT 20`);
        for (const row of pending) {
          try { await this.confirm(row.id); } catch (error) { console.error('Ticket reconciliation failed:', row.id, error.code || error.message); }
          await this.database.execute('UPDATE ticket_orders SET updated_at=NOW() WHERE id=?', [row.id]);
        }
      }
      if (this.stripe.configured()) {
        // If the server crashed after Stripe created Checkout but before its ID
        // was saved, recover it from Stripe before releasing any reserved stock.
        const [orphaned] = await this.database.execute(`SELECT id FROM ticket_orders WHERE payment_status='pending'
          AND checkout_session_id IS NULL AND created_at<DATE_SUB(NOW(),INTERVAL 40 MINUTE) LIMIT 10`);
        for (const row of orphaned) {
          try {
            const order = await this.checkoutOrder(row.id);
            let found = false;
            const since = Math.floor(new Date(order.createdAt).getTime() / 1000) - 60;
            for await (const session of this.stripe.stripeClient.checkout.sessions.list({ limit: 100, created: { gte: since } }, { stripeAccount: order.providerAccountId })) {
              if (session.metadata?.ticketOrderId === String(row.id) && session.client_reference_id === String(row.id)) {
                await this.attachCheckout(row.id, session);
                await this.confirm(row.id);
                found = true;
                break;
              }
            }
            if (!found) await this.database.execute("UPDATE ticket_orders SET payment_status='cancelled' WHERE id=? AND payment_status='pending' AND checkout_session_id IS NULL", [row.id]);
          } catch (error) { console.error('Orphan checkout recovery failed:', row.id, error.code || error.message); }
        }
      }
      const [jobs] = await this.database.execute(`SELECT ticket_order_id AS id FROM ticket_email_deliveries WHERE sent_at IS NULL
        AND next_attempt_at<=NOW() AND (locked_until IS NULL OR locked_until<NOW()) ORDER BY next_attempt_at LIMIT 20`);
      for (const job of jobs) await this.deliver(job.id);
    } finally { this.recovering = false; }
  }
}
