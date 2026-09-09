const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function calculateVenueBookingPrice({
  bookingType,
  startAt,
  endAt,
  hourlyRate,
  dailyRate,
  fallbackRate = 0,
  currency = 'SEK',
  taxMode = 'no_tax',
  defaultTaxRate = null,
  pricesIncludeTax = false,
  venueName = null,
}) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const durationMinutes = (end.getTime() - start.getTime()) / 60000;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return { error: 'INVALID_BOOKING_INTERVAL' };

  const type = bookingType === 'daily' ? 'daily' : 'hourly';
  const configuredRate = type === 'daily' ? dailyRate ?? fallbackRate : hourlyRate ?? fallbackRate;
  const unitPrice = Number(configuredRate);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: 'PRICE_NOT_CONFIGURED' };

  const quantity = type === 'daily' ? 1 : Math.round((durationMinutes / 60) * 1000) / 1000;
  const grossOrNet = money(quantity * unitPrice);
  const configuredTaxRate = taxMode === 'configured' ? Number(defaultTaxRate) : 0;
  if (!Number.isFinite(configuredTaxRate) || configuredTaxRate < 0 || configuredTaxRate > 100) return { error: 'INVALID_TAX_CONFIGURATION' };

  let subtotal;
  let taxAmount;
  let total;
  if (pricesIncludeTax && configuredTaxRate > 0) {
    total = grossOrNet;
    subtotal = money(total / (1 + configuredTaxRate / 100));
    taxAmount = money(total - subtotal);
  } else {
    subtotal = grossOrNet;
    taxAmount = money(subtotal * configuredTaxRate / 100);
    total = money(subtotal + taxAmount);
  }

  return {
    lineItems: [{
      description: `Venue rental${venueName ? `: ${venueName}` : ''}`,
      quantity,
      unit: type === 'daily' ? 'day' : 'hour',
      unitPrice: money(unitPrice),
      subtotal,
      taxRate: configuredTaxRate,
      taxAmount,
      total,
    }],
    subtotal,
    taxAmount,
    total,
    currency: String(currency || 'SEK').toUpperCase(),
    pricingRuleVersion: 'venue-booking-v1',
  };
}

export function venueFinancialReadiness(settings, seller, paymentSettings) {
  const invoiceMode = settings?.invoiceMode || 'ykcircle';
  const sellerBillingProfileReady = Boolean(
    seller
    && seller.isActive !== false
    && seller.profileType === 'organization'
    && seller.legalName
    && seller.addressLine1
    && seller.postalCode
    && seller.city
    && seller.country
    && seller.billingEmail,
  );
  const taxConfigurationReady = settings?.taxMode === 'no_tax'
    || (settings?.taxMode === 'configured' && Number.isFinite(Number(settings.defaultTaxRate)) && Number(settings.defaultTaxRate) >= 0 && Number(settings.defaultTaxRate) <= 100);
  const methods = Array.isArray(paymentSettings?.methods) ? paymentSettings.methods : [];
  const paymentInstructionsReady = invoiceMode === 'external' || methods.some((method) => {
    if (method === 'bankgiro') return Boolean(paymentSettings.bankgiro);
    if (method === 'plusgiro') return Boolean(paymentSettings.plusgiro);
    if (method === 'bank_transfer') return Boolean(paymentSettings.iban || paymentSettings.accountDetailsText);
    if (method === 'swish') return Boolean(paymentSettings.swishNumber);
    if (method === 'cash' || method === 'other') return Boolean(paymentSettings.additionalInstructions || paymentSettings.accountDetailsText);
    return false;
  });
  const termsAccepted = invoiceMode === 'external' || Boolean(settings?.acceptedTermsVersion && settings?.acceptedAt && settings?.acceptedByUserId);
  const invoiceSeriesReady = invoiceMode === 'external' || Boolean(seller?.invoicePrefix && /^[A-Z0-9-]{1,20}$/.test(seller.invoicePrefix));
  const canIssueInvoice = invoiceMode === 'external' || (sellerBillingProfileReady && invoiceSeriesReady && paymentInstructionsReady && taxConfigurationReady && termsAccepted);
  const missing = [];
  if (invoiceMode === 'ykcircle' && !sellerBillingProfileReady) missing.push('sellerBillingProfile');
  if (invoiceMode === 'ykcircle' && !invoiceSeriesReady) missing.push('invoiceSeries');
  if (invoiceMode === 'ykcircle' && !paymentInstructionsReady) missing.push('paymentInstructions');
  if (invoiceMode === 'ykcircle' && !taxConfigurationReady) missing.push('taxConfiguration');
  if (invoiceMode === 'ykcircle' && !termsAccepted) missing.push('invoiceAuthorization');
  return { invoiceMode, sellerBillingProfileReady, invoiceSeriesReady, paymentInstructionsReady, taxConfigurationReady, termsAccepted, canIssueInvoice, missing };
}
