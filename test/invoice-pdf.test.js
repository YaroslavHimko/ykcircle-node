import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInvoicePdf } from '../server/invoice-pdf.js';

test('renders a structured invoice and preserves Swedish WinAnsi characters', () => {
  const pdf = renderInvoicePdf({
    id: 12, invoiceNumber: 'YK-2026-12', issueDate: '2026-09-11', dueDate: '2026-10-11', currency: 'SEK', subtotal: 1000, taxAmount: 250, totalAmount: 1250,
    seller: { legalName: 'Mälarö Möten AB', addressLine1: 'Östra Ågatan 1', postalCode: '111 22', city: 'Stockholm' },
    buyer: { legalName: 'Åke Öberg', addressLine1: 'Ängsvägen 2', postalCode: '222 33', city: 'Malmö' },
    booking: { venueName: 'Södergården', eventTitle: 'Höstträff' },
    items: [{ description: 'Lokalkostnad för årsmöte', quantity: 1, unit: 'st', unitPrice: 1000, taxRate: 25, total: 1250 }],
    paymentInstructions: { bankgiro: '123-4567' },
  });
  const contents = pdf.toString('latin1');
  assert.match(contents, /<46414B54555241>/); // FAKTURA
  assert.match(contents, /<53C44C4A415245>/); // SÄLJARE
  assert.match(contents, /<4BD650415245>/); // KÖPARE
  assert.match(contents, /<4DE46C6172F6/); // Mälarö encoded as WinAnsi bytes
  assert.doesNotMatch(contents, /<3F73747261/); // not ?stra
});
