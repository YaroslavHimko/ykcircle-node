import crypto from 'node:crypto';
import { renderInvoicePdf } from '../../../services/billing/invoice-pdf.js';

export function createBillingDocuments({ ensureTable, queries }) {
  const downloadInvoicePdf = async (req, res) => {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId < 1)
      return res.status(422).json({ error: 'A valid invoice id is required.' });
    try {
      await ensureTable();
      const invoice = await queries.invoice(invoiceId, req.user.id, req.user.role);
      if (!invoice)
        return res.status(403).json({ error: 'Invoice not found or not available to you.' });
      const generated = renderInvoicePdf(invoice);
      const hash = crypto.createHash('sha256').update(generated).digest('hex');
      const document = await queries.storeInvoiceDocument(invoiceId, generated, hash);
      const pdf = document.pdfDocument;
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="invoice-${invoice.invoiceNumber || invoiceId}.pdf"`,
        'Cache-Control': 'private, no-store',
        ETag: `"${document.pdfHash}"`,
      });
      return res.send(pdf);
    } catch (error) {
      console.error('Invoice PDF generation failed:', error.message);
      return res.status(500).json({ error: 'Unable to download invoice.' });
    }
  };
  const testPaymentsEnabled =
    process.env.NODE_ENV !== 'production' || process.env.PAYMENTS_TEST_MODE === 'true';
  return { downloadInvoicePdf, testPaymentsEnabled };
}
