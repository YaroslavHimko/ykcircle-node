import { jsonValue } from '../../../utils/serialization.js';
export class BillingInvoicesRepository {
  constructor({ database, queries }) {
    this.database = database;
    this.queries = queries;
  }
  async allocateInvoiceNumber(
    connection,
    sellerBillingProfileId,
    prefix,
    issueYear = new Date().getUTCFullYear(),
  ) {
    // The row lock makes a per-seller/year sequence safe under concurrent
    // issuance. Draft invoices never call this method.
    const [seriesRows] = await connection.execute(
      `SELECT id, prefix, next_number AS nextNumber FROM invoice_series
      WHERE seller_billing_profile_id=? AND year=? FOR UPDATE`,
      [sellerBillingProfileId, issueYear],
    );
    let series = seriesRows[0];
    if (!series) {
      const normalizedPrefix =
        String(prefix || 'INV')
          .toUpperCase()
          .replace(/[^A-Z0-9-]/g, '')
          .slice(0, 20) || 'INV';
      const [insert] = await connection.execute(
        `INSERT INTO invoice_series (seller_billing_profile_id, prefix, year, next_number)
        VALUES (?, ?, ?, 2)`,
        [sellerBillingProfileId, normalizedPrefix, issueYear],
      );
      series = { id: insert.insertId, prefix: normalizedPrefix, nextNumber: 1 };
    } else {
      await connection.execute('UPDATE invoice_series SET next_number=? WHERE id=?', [
        Number(series.nextNumber) + 1,
        series.id,
      ]);
    }
    return {
      seriesId: series.id,
      invoiceNumber: `${series.prefix}-${issueYear}-${String(series.nextNumber).padStart(4, '0')}`,
    };
  }

  async canAccessInvoice(userId, role, invoiceId) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(
      `SELECT i.id FROM invoices i
      LEFT JOIN billing_profiles seller_profile ON seller_profile.id=i.seller_billing_profile_id
      LEFT JOIN billing_profiles buyer_profile ON buyer_profile.id=i.buyer_billing_profile_id
      LEFT JOIN organization_members seller_member ON seller_member.organization_id=COALESCE(i.seller_organization_id, seller_profile.owner_organization_id) AND seller_member.user_id=?
      LEFT JOIN organization_members buyer_member ON buyer_member.organization_id=COALESCE(i.buyer_organization_id, buyer_profile.owner_organization_id) AND buyer_member.user_id=? WHERE i.id=? AND
      (i.buyer_user_id=? OR buyer_profile.owner_user_id=? OR seller_profile.owner_user_id=? OR seller_member.role IN ('owner','admin','manager') OR buyer_member.role IN ('owner','admin'))`,
      [userId, userId, invoiceId, userId, userId, userId],
    );
    return Boolean(rows[0]);
  }

  async canManageInvoicePayment(userId, role, invoiceId) {
    if (['manager', 'admin'].includes(role)) return true;
    const [rows] = await this.database.execute(
      `SELECT invoice.id FROM invoices invoice
      LEFT JOIN billing_profiles seller ON seller.id=invoice.seller_billing_profile_id
      LEFT JOIN organization_members member ON member.organization_id=COALESCE(invoice.seller_organization_id, seller.owner_organization_id) AND member.user_id=?
      WHERE invoice.id=? AND (seller.owner_user_id=? OR member.role IN ('owner','admin'))`,
      [userId, invoiceId, userId],
    );
    return Boolean(rows[0]);
  }

  async invoicesForViewer(userId, role, { venueId = null } = {}) {
    const privileged = ['manager', 'admin'].includes(role);
    const access = privileged
      ? 'TRUE'
      : `(i.buyer_user_id=? OR buyer_profile.owner_user_id=? OR seller_profile.owner_user_id=? OR EXISTS (SELECT 1 FROM organization_members seller_member
      WHERE seller_member.organization_id=COALESCE(i.seller_organization_id, seller_profile.owner_organization_id) AND seller_member.user_id=? AND seller_member.role IN ('owner','admin','manager')) OR EXISTS (SELECT 1 FROM organization_members buyer_member
      WHERE buyer_member.organization_id=COALESCE(i.buyer_organization_id, buyer_profile.owner_organization_id) AND buyer_member.user_id=? AND buyer_member.role IN ('owner','admin')))`;
    const [rows] = await this.database.execute(
      `SELECT i.id, i.seller_organization_id AS sellerOrganizationId, i.seller_billing_profile_id AS sellerBillingProfileId,
      COALESCE(seller.name, seller_profile.legal_name) AS sellerOrganizationName, i.buyer_user_id AS buyerUserId,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(i.buyer_snapshot_json, '$.legalName')), buyer_profile.legal_name, buyer.name) AS buyerName,
      i.buyer_organization_id AS buyerOrganizationId, i.buyer_billing_profile_id AS buyerBillingProfileId, i.booking_id AS bookingId, booking.venue_id AS venueId, i.invoice_number AS invoiceNumber,
      i.context_type AS contextType, i.context_id AS contextId, i.status, i.delivery_status AS deliveryStatus, i.issue_date AS issueDate, i.due_date AS dueDate, i.currency,
      i.subtotal, i.tax_amount AS taxAmount, i.total_amount AS totalAmount, i.paid_at AS paidAt,
      e.id AS eventId, e.title AS eventTitle, i.created_at AS createdAt
      FROM invoices i LEFT JOIN organizations seller ON seller.id=i.seller_organization_id
      LEFT JOIN billing_profiles seller_profile ON seller_profile.id=i.seller_billing_profile_id
      LEFT JOIN billing_profiles buyer_profile ON buyer_profile.id=i.buyer_billing_profile_id
      LEFT JOIN users buyer ON buyer.id=i.buyer_user_id
      LEFT JOIN venue_bookings booking ON booking.id=i.booking_id
      LEFT JOIN events e ON e.id=booking.event_id
      WHERE ${access}${venueId === null ? '' : ' AND booking.venue_id=?'} ORDER BY i.created_at DESC, i.id DESC`,
      privileged
        ? venueId === null
          ? []
          : [venueId]
        : [...[userId, userId, userId, userId, userId], ...(venueId === null ? [] : [venueId])],
    );
    return rows;
  }

  async invoice(invoiceId, userId, role) {
    if (!(await this.queries.canAccessInvoice(userId, role, invoiceId))) return null;
    const [rows] = await this.database.execute(
      `SELECT id, seller_organization_id AS sellerOrganizationId, seller_billing_profile_id AS sellerBillingProfileId, buyer_user_id AS buyerUserId,
      buyer_organization_id AS buyerOrganizationId, buyer_billing_profile_id AS buyerBillingProfileId, booking_id AS bookingId, context_type AS contextType, context_id AS contextId, invoice_series_id AS invoiceSeriesId, invoice_number AS invoiceNumber, status, delivery_status AS deliveryStatus,
      issue_date AS issueDate, due_date AS dueDate, currency, subtotal, tax_amount AS taxAmount, total_amount AS totalAmount,
      pdf_generated_at AS pdfGeneratedAt, pdf_hash AS pdfHash, paid_at AS paidAt, paid_date AS paidDate, manual_payment_reference AS manualPaymentReference,
      manual_payment_method AS manualPaymentMethod, manual_payment_note AS manualPaymentNote, voided_at AS voidedAt, void_reason AS voidReason, seller_snapshot_json AS sellerSnapshot,
      buyer_snapshot_json AS buyerSnapshot, booking_snapshot_json AS bookingSnapshot, tax_snapshot_json AS taxSnapshot,
      payment_instructions_snapshot AS paymentInstructions, created_at AS createdAt FROM invoices WHERE id=?`,
      [invoiceId],
    );
    if (!rows[0]) return null;
    const [items] = await this.database.execute(
      `SELECT id, description, quantity, unit, unit_price AS unitPrice, tax_rate AS taxRate,
      subtotal, tax_amount AS taxAmount, total FROM invoice_items WHERE invoice_id=? ORDER BY id`,
      [invoiceId],
    );
    const invoice = rows[0];
    return {
      ...invoice,
      seller: jsonValue(invoice.sellerSnapshot),
      buyer: jsonValue(invoice.buyerSnapshot),
      booking: jsonValue(invoice.bookingSnapshot),
      tax: jsonValue(invoice.taxSnapshot),
      paymentInstructions: jsonValue(invoice.paymentInstructions) || invoice.paymentInstructions,
      items,
      canManage: await this.queries.canManageInvoicePayment(userId, role, invoiceId),
    };
  }

  async markInvoicePaid(
    invoiceId,
    userId,
    role,
    { paymentReference = null, paymentMethod, paidDate = null, internalNote = null },
  ) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      // Lock before authorization/state transition so simultaneous manual
      // reconciliation produces one audit event.
      const [rows] = await connection.execute(
        `SELECT i.id, i.status, i.seller_organization_id AS sellerOrganizationId, seller_profile.owner_user_id AS sellerProfileOwnerUserId, i.booking_id AS bookingId, i.currency, i.total_amount AS totalAmount FROM invoices i
        LEFT JOIN billing_profiles seller_profile ON seller_profile.id=i.seller_billing_profile_id
        WHERE i.id=? FOR UPDATE`,
        [invoiceId],
      );
      const invoice = rows[0];
      if (!invoice) {
        await connection.rollback();
        return false;
      }
      if (
        !['manager', 'admin'].includes(role) &&
        Number(invoice.sellerProfileOwnerUserId) !== Number(userId)
      ) {
        const [members] = await connection.execute(
          `SELECT role FROM organization_members
        WHERE organization_id=? AND user_id=? AND role IN ('owner','admin')`,
          [invoice.sellerOrganizationId, userId],
        );
        if (!members[0]) {
          await connection.rollback();
          return false;
        }
      }
      if (!['issued', 'sent', 'overdue'].includes(invoice.status)) {
        await connection.rollback();
        return { error: 'INVALID_STATE' };
      }
      await connection.execute(
        `UPDATE invoices SET status='paid', paid_at=NOW(), paid_date=COALESCE(?, CURDATE()), paid_by_user_id=?, manual_payment_reference=?, manual_payment_method=?, manual_payment_note=? WHERE id=?`,
        [paidDate, userId, paymentReference, paymentMethod, internalNote, invoiceId],
      );
      await connection.execute(
        `INSERT INTO payments (invoice_id, booking_id, provider, status, currency, amount, payment_method_type, metadata_json, paid_at)
        VALUES (?, ?, 'manual', 'succeeded', ?, ?, ?, ?, NOW())`,
        [
          invoiceId,
          invoice.bookingId,
          invoice.currency,
          invoice.totalAmount,
          paymentMethod,
          JSON.stringify({
            ...(paymentReference ? { reference: paymentReference } : {}),
            ...(paidDate ? { paidDate } : {}),
            ...(internalNote ? { internalNote } : {}),
          }),
        ],
      );
      if (invoice.bookingId)
        await connection.execute("UPDATE venue_bookings SET payment_status='paid' WHERE id=?", [
          invoice.bookingId,
        ]);
      await connection.execute(
        `INSERT INTO invoice_history (invoice_id, action, previous_status, new_status, performed_by_user_id) VALUES (?, 'marked_paid', ?, 'paid', ?)`,
        [invoiceId, invoice.status, userId],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async simulatePayment(invoiceId, userId, role, succeeded) {
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(
        `SELECT id, booking_id AS bookingId, seller_organization_id AS sellerOrganizationId, status, currency, total_amount AS totalAmount FROM invoices WHERE id=? FOR UPDATE`,
        [invoiceId],
      );
      const invoice = rows[0];
      if (!invoice || !(await this.queries.canAccessInvoice(userId, role, invoiceId))) {
        await connection.rollback();
        return false;
      }
      if (!['issued', 'sent', 'overdue'].includes(invoice.status)) {
        await connection.rollback();
        return { error: 'INVALID_STATE' };
      }
      const status = succeeded ? 'succeeded' : 'failed';
      const [payment] = await connection.execute(
        `INSERT INTO payments (invoice_id, booking_id, provider, status, currency, amount, payment_method_type, payment_method_brand, payment_method_last4, ${succeeded ? 'paid_at' : 'failed_at'})
        VALUES (?, ?, 'test_stub', ?, ?, ?, 'card', 'Test Card', '4242', NOW())`,
        [invoiceId, invoice.bookingId, status, invoice.currency, invoice.totalAmount],
      );
      if (succeeded) {
        await connection.execute("UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=?", [
          invoiceId,
        ]);
        await connection.execute("UPDATE venue_bookings SET payment_status='paid' WHERE id=?", [
          invoice.bookingId,
        ]);
      }
      await connection.execute(
        `INSERT INTO invoice_history (invoice_id, action, previous_status, new_status, performed_by_user_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          succeeded ? 'test_payment_succeeded' : 'test_payment_failed',
          invoice.status,
          succeeded ? 'paid' : invoice.status,
          userId,
          JSON.stringify({ paymentId: payment.insertId, provider: 'test_stub' }),
        ],
      );
      await connection.commit();
      return { id: payment.insertId, status, invoiceStatus: succeeded ? 'paid' : invoice.status };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recordInvoicePdf(invoiceId, hash) {
    await this.database.execute(
      'UPDATE invoices SET pdf_hash=COALESCE(pdf_hash, ?), pdf_generated_at=COALESCE(pdf_generated_at, NOW()) WHERE id=?',
      [hash, invoiceId],
    );
  }

  async invoiceDocument(invoiceId) {
    const [rows] = await this.database.execute(
      'SELECT pdf_document AS pdfDocument, pdf_hash AS pdfHash, generated_at AS generatedAt FROM invoice_documents WHERE invoice_id=?',
      [invoiceId],
    );
    return rows[0] || null;
  }

  async storeInvoiceDocument(invoiceId, pdfDocument, pdfHash) {
    // The invoice snapshots are immutable, but the document renderer can be
    // corrected. Keep the cached PDF in sync with that snapshot so an already
    // issued invoice does not keep a known formatting defect forever.
    await this.database.execute(
      `INSERT INTO invoice_documents (invoice_id, pdf_document, pdf_hash, generated_at)
      VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE pdf_document=VALUES(pdf_document), pdf_hash=VALUES(pdf_hash), generated_at=VALUES(generated_at)`,
      [invoiceId, pdfDocument, pdfHash],
    );
    await this.database.execute(
      'UPDATE invoices SET pdf_storage_key=COALESCE(pdf_storage_key, ?), pdf_hash=?, pdf_generated_at=NOW() WHERE id=?',
      [`database:invoice_documents/${invoiceId}`, pdfHash, invoiceId],
    );
    return this.queries.invoiceDocument(invoiceId);
  }

  async markVenueInvoiceGenerationFailed(bookingId, error) {
    await this.database.execute(
      "UPDATE venue_bookings SET invoice_generation_status='failed', invoice_generation_error=? WHERE id=?",
      [String(error || 'Invoice document generation failed').slice(0, 500), bookingId],
    );
  }
}
