const pdfText = (value) => String(value ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, '\\$&');

// A deliberately small, dependency-free accounting document. The invoice data
// has already been snapshotted before this is called, so rendering cannot pull
// mutable seller, buyer, venue, or user data into a historical document.
export const renderInvoicePdf = (invoice) => {
  const seller = invoice.seller || {}; const buyer = invoice.buyer || {}; const booking = invoice.booking || {};
  const payment = typeof invoice.paymentInstructions === 'string' ? { additionalInstructions: invoice.paymentInstructions } : (invoice.paymentInstructions || {});
  const paymentLines = [
    payment.bankgiro && `Bankgiro: ${payment.bankgiro}`, payment.plusgiro && `Plusgiro: ${payment.plusgiro}`,
    payment.iban && `IBAN: ${payment.iban}`, payment.bic && `BIC: ${payment.bic}`, payment.swishNumber && `Swish: ${payment.swishNumber}`,
    payment.bankName, payment.accountDetailsText, payment.additionalInstructions,
  ].filter(Boolean);
  const lines = [
    'INVOICE', `Invoice #: ${invoice.invoiceNumber || invoice.id}`, `Issue date: ${invoice.issueDate || ''}`, `Due date: ${invoice.dueDate || ''}`, '',
    'SELLER', seller.legalName, (seller.organizationNumber || seller.registrationNumber) && `Registration #: ${seller.organizationNumber || seller.registrationNumber}`, seller.vatNumber && `VAT #: ${seller.vatNumber}`,
    seller.addressLine1, seller.addressLine2, [seller.postalCode, seller.city].filter(Boolean).join(' '), seller.country, seller.billingEmail, '',
    'BILL TO', buyer.legalName, (buyer.organizationNumber || buyer.registrationNumber) && `Registration #: ${buyer.organizationNumber || buyer.registrationNumber}`, buyer.vatNumber && `VAT #: ${buyer.vatNumber}`,
    buyer.addressLine1, buyer.addressLine2, [buyer.postalCode, buyer.city].filter(Boolean).join(' '), buyer.country, buyer.billingEmail, '',
    'BOOKING', booking.bookingReference, booking.venueName, booking.venueAddress, booking.eventTitle, booking.startsAt && `Service: ${booking.startsAt} - ${booking.endsAt || ''}`, booking.venueTimezone && `Venue timezone: ${booking.venueTimezone}`, '',
    ...invoice.items.flatMap((item) => [`${item.description}: ${item.quantity} ${item.unit} x ${item.unitPrice} ${invoice.currency} = ${item.total} ${invoice.currency}`]),
    '', `Subtotal: ${invoice.subtotal} ${invoice.currency}`, `Tax: ${invoice.taxAmount} ${invoice.currency}`, `AMOUNT DUE: ${invoice.totalAmount} ${invoice.currency}`,
    '', 'PAYMENT INSTRUCTIONS', ...paymentLines, `Reference: ${invoice.invoiceNumber || invoice.id}`,
    '', 'Generated through YKCircle on behalf of the seller.',
  ].filter(Boolean).map(pdfText);
  const content = ['BT', '/F1 10 Tf', '48 792 Td', ...lines.flatMap((line, index) => [`(${line}) Tj`, index === lines.length - 1 ? '' : '0 -14 Td']).filter(Boolean), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'utf8')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'utf8'); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
};
