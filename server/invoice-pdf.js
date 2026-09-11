const winAnsiOverrides = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e],
  ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97], ['˜', 0x98], ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

// Helvetica with WinAnsi encoding covers Swedish characters such as å, ä, and ö.
// Hex strings avoid PDF literal-string escaping and make the byte encoding explicit.
const pdfText = (value) => {
  const bytes = [];
  for (const character of String(value ?? '')) {
    const code = character.codePointAt(0);
    bytes.push(winAnsiOverrides.get(character) ?? (code >= 0x20 && code <= 0xff ? code : 0x3f));
  }
  return `<${Buffer.from(bytes).toString('hex').toUpperCase()}>`;
};

const cleanLines = (values) => values.filter((value) => value != null && String(value).trim() !== '').map((value) => String(value).trim());
const date = (value) => value ? String(value).slice(0, 10) : '—';
const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const money = (value, currency) => {
  const amount = Number(value);
  const formatted = Number.isFinite(amount)
    ? new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : text(value);
  return `${formatted} ${currency || ''}`.trim();
};

const wrap = (value, maxChars) => {
  const words = text(value).split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line || `${line} ${word}`.length <= maxChars) line = line ? `${line} ${word}` : word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
};

const color = {
  ink: [0.12, 0.15, 0.19], muted: [0.36, 0.41, 0.47], orange: [0.93, 0.28, 0.06],
  paleOrange: [1, 0.95, 0.91], paleBlue: [0.96, 0.97, 0.98], line: [0.84, 0.87, 0.9], white: [1, 1, 1],
};
const rgb = ([red, green, blue]) => `${red} ${green} ${blue}`;

// A deliberately small, dependency-free accounting document. The invoice data
// has already been snapshotted before this is called, so rendering cannot pull
// mutable seller, buyer, venue, or user data into a historical document.
export const renderInvoicePdf = (invoice) => {
  const seller = invoice.seller || {};
  const buyer = invoice.buyer || {};
  const booking = invoice.booking || {};
  const currency = invoice.currency || 'SEK';
  const payment = typeof invoice.paymentInstructions === 'string' ? { additionalInstructions: invoice.paymentInstructions } : (invoice.paymentInstructions || {});
  const paymentLines = cleanLines([
    payment.bankgiro && `Bankgiro: ${payment.bankgiro}`, payment.plusgiro && `Plusgiro: ${payment.plusgiro}`,
    payment.iban && `IBAN: ${payment.iban}`, payment.bic && `BIC: ${payment.bic}`, payment.swishNumber && `Swish: ${payment.swishNumber}`,
    payment.bankName, payment.accountDetailsText, payment.additionalInstructions, `OCR / referens: ${invoice.invoiceNumber || invoice.id}`,
  ]).flatMap((line) => wrap(line, 88));
  const sellerLines = cleanLines([
    seller.legalName, (seller.organizationNumber || seller.registrationNumber) && `Org.nr: ${seller.organizationNumber || seller.registrationNumber}`,
    seller.vatNumber && `Momsreg.nr: ${seller.vatNumber}`, seller.addressLine1, seller.addressLine2,
    [seller.postalCode, seller.city].filter(Boolean).join(' '), seller.country, seller.billingEmail,
  ]).flatMap((line) => wrap(line, 41));
  const buyerLines = cleanLines([
    buyer.legalName, (buyer.organizationNumber || buyer.registrationNumber) && `Org.nr: ${buyer.organizationNumber || buyer.registrationNumber}`,
    buyer.vatNumber && `Momsreg.nr: ${buyer.vatNumber}`, buyer.addressLine1, buyer.addressLine2,
    [buyer.postalCode, buyer.city].filter(Boolean).join(' '), buyer.country, buyer.billingEmail,
  ]).flatMap((line) => wrap(line, 41));

  const pages = [];
  let commands = [];
  let y = 0;
  let pageNumber = 0;
  const command = (value) => commands.push(value);
  const drawText = (value, x, baseline, size = 9, font = 'F1', fill = color.ink) => command(`BT /${font} ${size} Tf ${rgb(fill)} rg 1 0 0 1 ${x} ${baseline} Tm ${pdfText(value)} Tj ET`);
  const rect = (x, bottom, width, height, fill, stroke) => {
    command('q');
    if (fill) command(`${rgb(fill)} rg ${x} ${bottom} ${width} ${height} re f`);
    if (stroke) command(`${rgb(stroke)} RG 0.6 w ${x} ${bottom} ${width} ${height} re S`);
    command('Q');
  };
  const rule = (x1, baseline, x2, stroke = color.line, width = 0.7) => command(`q ${rgb(stroke)} RG ${width} w ${x1} ${baseline} m ${x2} ${baseline} l S Q`);
  const footer = () => {
    rule(48, 45, 564);
    drawText('Genererad via YKCircle på uppdrag av säljaren.', 48, 30, 7.5, 'F1', color.muted);
    drawText(`Sida ${pageNumber}`, 523, 30, 7.5, 'F1', color.muted);
  };
  const startPage = () => {
    if (commands.length) { footer(); pages.push(commands.join('\n')); }
    commands = [];
    pageNumber += 1;
    if (pageNumber === 1) {
      // Text wordmark serves as a crisp, print-safe version of the YKCircle logo.
      drawText('Y', 48, 776, 30, 'F2', color.orange);
      drawText('K', 68, 776, 30, 'F2', color.ink);
      drawText('CIRCLE', 91, 780, 9, 'F2', color.muted);
      drawText('FAKTURA', 424, 780, 20, 'F2', color.ink);
      drawText(`Nr ${invoice.invoiceNumber || invoice.id}`, 459, 762, 9, 'F1', color.muted);
      rule(48, 742, 564, color.orange, 1.4);
      y = 718;
    } else {
      drawText('YK CIRCLE', 48, 782, 10, 'F2', color.ink);
      drawText(`FAKTURA ${invoice.invoiceNumber || invoice.id}`, 414, 782, 10, 'F2', color.ink);
      rule(48, 768, 564, color.orange, 1.2);
      y = 744;
    }
  };
  const ensureSpace = (height) => { if (y - height < 70) startPage(); };
  const section = (title) => {
    ensureSpace(26);
    drawText(title, 48, y, 9, 'F2', color.orange);
    rule(48, y - 6, 564);
    y -= 22;
  };
  const infoCard = (title, x, width, lines, height) => {
    const bottom = y - height;
    rect(x, bottom, width, height, color.paleBlue, color.line);
    drawText(title, x + 12, y - 16, 8, 'F2', color.muted);
    let lineY = y - 33;
    lines.forEach((line, index) => { drawText(line, x + 12, lineY, index === 0 ? 9.5 : 8.5, index === 0 ? 'F2' : 'F1', color.ink); lineY -= 12; });
  };
  const details = (rows) => {
    const height = Math.ceil(rows.length / 2) * 30 + 12;
    ensureSpace(height);
    rect(48, y - height, 516, height, color.paleBlue, color.line);
    rows.forEach(([label, value], index) => {
      const x = 60 + (index % 2) * 252;
      const baseline = y - 16 - Math.floor(index / 2) * 30;
      drawText(label.toUpperCase(), x, baseline, 7.5, 'F2', color.muted);
      drawText(value || '—', x, baseline - 12, 9, 'F1', color.ink);
    });
    y -= height + 18;
  };
  const itemHeader = () => {
    ensureSpace(28);
    rect(48, y - 22, 516, 22, color.ink);
    drawText('BESKRIVNING', 58, y - 14, 7.5, 'F2', color.white);
    drawText('ANTAL', 288, y - 14, 7.5, 'F2', color.white);
    drawText('PRIS', 362, y - 14, 7.5, 'F2', color.white);
    drawText('MOMS', 437, y - 14, 7.5, 'F2', color.white);
    drawText('BELOPP', 503, y - 14, 7.5, 'F2', color.white);
    y -= 22;
  };

  startPage();
  const cardsHeight = Math.max(92, 42 + Math.max(sellerLines.length, buyerLines.length) * 12);
  ensureSpace(cardsHeight);
  infoCard('SÄLJARE', 48, 246, sellerLines, cardsHeight);
  infoCard('KÖPARE', 318, 246, buyerLines, cardsHeight);
  y -= cardsHeight + 20;

  section('FAKTURAUPPGIFTER');
  details([['Fakturanummer', invoice.invoiceNumber || invoice.id], ['Valuta', currency], ['Fakturadatum', date(invoice.issueDate)], ['Förfallodatum', date(invoice.dueDate)]]);

  const bookingRows = cleanLines([
    booking.bookingReference && `Bokningsreferens: ${booking.bookingReference}`, booking.venueName && `Lokal: ${booking.venueName}`,
    booking.venueAddress, booking.eventTitle && `Evenemang: ${booking.eventTitle}`,
    booking.startsAt && `Tjänsteperiod: ${booking.startsAt}${booking.endsAt ? ` – ${booking.endsAt}` : ''}`, booking.venueTimezone && `Tidszon: ${booking.venueTimezone}`,
  ]).flatMap((line) => wrap(line, 96));
  if (bookingRows.length) {
    section('BOKNINGSUPPGIFTER');
    const height = 18 + bookingRows.length * 12;
    ensureSpace(height);
    rect(48, y - height, 516, height, color.paleBlue, color.line);
    bookingRows.forEach((line, index) => drawText(line, 60, y - 16 - index * 12, 8.5, 'F1', color.ink));
    y -= height + 18;
  }

  section('SPECIFIKATION');
  itemHeader();
  (invoice.items || []).forEach((item) => {
    const description = wrap(item.description || '—', 36);
    const height = Math.max(27, description.length * 11 + 12);
    if (y - height < 70) { startPage(); itemHeader(); }
    description.forEach((line, index) => drawText(line, 58, y - 14 - index * 11, 8.5, index === 0 ? 'F2' : 'F1', color.ink));
    drawText(`${item.quantity ?? ''} ${item.unit || ''}`.trim(), 288, y - 14, 8, 'F1', color.ink);
    drawText(money(item.unitPrice, currency), 354, y - 14, 8, 'F1', color.ink);
    drawText(`${item.taxRate ?? 0}%`, 441, y - 14, 8, 'F1', color.ink);
    drawText(money(item.total, currency), 492, y - 14, 8, 'F1', color.ink);
    rule(48, y - height, 564, color.line, 0.45);
    y -= height;
  });

  const totalHeight = 72;
  ensureSpace(totalHeight + 18);
  rect(330, y - totalHeight, 234, totalHeight, color.paleOrange, color.orange);
  drawText('DELSUMMA', 342, y - 18, 8, 'F2', color.muted);
  drawText(money(invoice.subtotal, currency), 468, y - 18, 8.5, 'F1', color.ink);
  drawText('MOMS', 342, y - 35, 8, 'F2', color.muted);
  drawText(money(invoice.taxAmount, currency), 468, y - 35, 8.5, 'F1', color.ink);
  rule(342, y - 43, 552, color.orange, 0.7);
  drawText('ATT BETALA', 342, y - 60, 9, 'F2', color.ink);
  drawText(money(invoice.totalAmount, currency), 458, y - 60, 11, 'F2', color.ink);
  y -= totalHeight + 20;

  if (paymentLines.length) {
    section('BETALNINGSUPPGIFTER');
    const height = Math.max(42, 20 + paymentLines.length * 12);
    ensureSpace(height);
    rect(48, y - height, 516, height, color.paleBlue, color.line);
    paymentLines.forEach((line, index) => drawText(line, 60, y - 16 - index * 12, 8.5, 'F1', color.ink));
    y -= height + 16;
  }

  footer();
  pages.push(commands.join('\n'));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${index + 5} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ...pages.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${index + 5 + pages.length} 0 R >>`),
    ...pages.map((content) => `<< /Length ${Buffer.byteLength(content, 'utf8')} >>\nstream\n${content}\nendstream`),
  ];
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'utf8')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
};
