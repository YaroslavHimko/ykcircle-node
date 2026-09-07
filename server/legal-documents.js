import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const documentDirectory = new URL('./legal-documents/', import.meta.url);

// Only public-facing agreements belong here. Keep implementation notes and
// internal compliance material out of this registry.
const documents = [
  { slug: 'terms', documentType: 'terms', title: 'Terms of Service', file: '01_TERMS_OF_SERVICE.md', version: '2026-09-07', requiresReacceptance: true },
  { slug: 'privacy', documentType: 'privacy', title: 'Privacy Policy', file: '02_PRIVACY_POLICY.md', version: '2026-09-07', requiresReacceptance: false },
  { slug: 'community-guidelines', documentType: 'community_guidelines', title: 'Community Guidelines', file: '03_COMMUNITY_GUIDELINES.md', version: '2026-09-07', requiresReacceptance: false },
  { slug: 'organizer-terms', documentType: 'organizer_terms', title: 'Organizer & Ticket Seller Terms', file: '04_ORGANIZER_AND_TICKET_SELLER_TERMS.md', version: '2026-09-07', requiresReacceptance: true },
  { slug: 'venue-terms', documentType: 'venue_terms', title: 'Venue Owner & Booking Terms', file: '05_VENUE_OWNER_AND_BOOKING_TERMS.md', version: '2026-09-07', requiresReacceptance: true },
  { slug: 'tickets-refunds', documentType: 'ticket_refund_policy', title: 'Tickets, Cancellations & Refunds', file: '06_TICKETS_CANCELLATIONS_REFUNDS.md', version: '2026-09-07', requiresReacceptance: false },
  { slug: 'paid-services', documentType: 'paid_services_terms', title: 'YKCircle Paid Services & Subscriptions', file: '07_YKCIRCLE_PAID_SERVICES_AND_SUBSCRIPTIONS.md', version: '2026-09-07', requiresReacceptance: true },
  { slug: 'cookies', documentType: 'cookie_policy', title: 'Cookie & Similar Technologies Policy', file: '08_COOKIE_AND_SIMILAR_TECHNOLOGIES_POLICY.md', version: '2026-09-07', requiresReacceptance: false },
  { slug: 'marketplace-transparency', documentType: 'marketplace_transparency', title: 'Marketplace Transparency', file: '09_MARKETPLACE_TRANSPARENCY.md', version: '2026-09-07', requiresReacceptance: false },
];

const publicMetadata = ({ slug, documentType, title, version }) => ({ slug, documentType, title, version, url: `/api/legal-documents/${slug}`, format: 'markdown' });

export const legalDocumentIndex = () => documents.map(publicMetadata);

const configured = (value, fallback) => String(value || '').trim() || fallback;

const replacementValues = (config = {}) => {
  const operator = config.operator || {};
  const site = config.site || {};
  const legal = config.legal || {};
  const minimumUserAge = config.runtime?.minimumUserAge || 18;
  const siteUrl = String(site.siteUrl || '').replace(/\/$/, '');
  const supportEmail = configured(operator.supportEmail || operator.email, 'Support contact is not yet published');
  const privacyEmail = configured(operator.privacyEmail || operator.email, 'Privacy contact is not yet published');
  const paymentProvider = configured(legal.paymentProvider, 'the payment provider identified at checkout');
  return {
  '[LEGAL OPERATOR NAME]': configured(operator.name, 'Legal operator details are not yet published'),
  '[LEGAL COMPANY NAME]': configured(operator.name, 'Legal operator details are not yet published'),
  '[ORGANISATION NUMBER]': configured(operator.organisationNumber, 'Not applicable while the Platform is operated by an individual'),
  '[ORGANISATION NUMBER, IF APPLICABLE]': configured(operator.organisationNumber, 'Not applicable while the Platform is operated by an individual'),
  '[ORG NUMBER]': configured(operator.organisationNumber, 'Not applicable while the Platform is operated by an individual'),
  '[VAT NUMBER, IF APPLICABLE]': configured(operator.vatNumber, 'Not applicable while the Platform is operated by an individual'),
  '[ADDRESS]': configured(operator.registeredAddress, 'Available on request via the support email'),
  '[REGISTERED ADDRESS]': configured(operator.registeredAddress, 'Available on request via the support email'),
  '[PRIVACY EMAIL]': operator.privacyEmail || operator.email || '[PRIVACY EMAIL]',
  '[SUPPORT EMAIL]': supportEmail,
  '[MODERATION EMAIL]': configured(operator.moderationEmail || operator.email, 'Moderation contact is not yet published'),
  '[BILLING SUPPORT EMAIL]': configured(legal.billingSupportEmail || operator.supportEmail || operator.email, supportEmail),
  '[TICKET SUPPORT EMAIL]': configured(legal.ticketSupportEmail || operator.supportEmail || operator.email, supportEmail),
  '[TICKET SUPPORT EMAIL / URL]': configured(legal.ticketSupportUrl || legal.ticketSupportEmail || operator.supportEmail || operator.email, supportEmail),
  '[VENUE SUPPORT EMAIL / URL]': configured(legal.venueSupportUrl || legal.venueSupportEmail || operator.supportEmail || operator.email, supportEmail),
  '[ORGANIZER SUPPORT URL]': configured(legal.organizerSupportUrl || legal.businessSupportUrl || operator.supportEmail || operator.email, supportEmail),
  '[BUSINESS SUPPORT EMAIL / URL]': configured(legal.businessSupportUrl || operator.supportEmail || operator.email, supportEmail),
  '[REPORT ILLEGAL CONTENT URL]': `${siteUrl}/report`,
  '[REPORT CONTENT URL]': `${siteUrl}/report`,
  '[REPORT URL]': `${siteUrl}/report`,
  '[APPEAL URL]': `${siteUrl}/appeal`,
  '[PRIVACY REQUEST URL / EMAIL]': privacyEmail,
  '[ACCOUNT DELETION URL]': `${siteUrl}/settings/privacy`,
  '[COOKIE SETTINGS LINK]': `${siteUrl}/cookies`,
  '[SUBPROCESSOR LIST URL]': `${siteUrl}/subprocessors`,
  '[WITHDRAWAL FUNCTION URL]': configured(legal.withdrawalFunctionUrl, 'Not available until YKCircle paid services are launched'),
  '[PAYMENT PROVIDER]': paymentProvider,
  '[PAYMENT PROVIDER PRIVACY LINK]': configured(legal.paymentProviderPrivacyUrl, 'shown by the payment provider at checkout'),
  '[ACTUAL ANALYTICS PROVIDERS OR "NONE"]': configured(legal.analyticsProviders, 'None configured'),
  '[ACTUAL MARKETING PROVIDERS OR "NONE"]': configured(legal.marketingProviders, 'None configured'),
  '[ACTUAL]': configured(legal.cookieInventory, 'Not configured; non-essential technologies remain disabled'),
  '[MINIMUM AGE]': String(minimumUserAge),
  '[DATE]': '7 September 2026',
  };
};

const renderContent = (content, config) => Object.entries(replacementValues(config))
  .reduce((rendered, [token, value]) => rendered.replaceAll(token, value), content);

export const legalDocument = async (slug, config = null) => {
  const document = documents.find((candidate) => candidate.slug === slug || candidate.documentType === slug);
  if (!document) return null;
  const content = renderContent(await readFile(fileURLToPath(new URL(document.file, documentDirectory)), 'utf8'), config);
  const lastUpdated = content.match(/^>\s*Last updated:\s*(.+)$/mi)?.[1]?.trim() || null;
  return { ...publicMetadata(document), version: document.version, requiresReacceptance: document.requiresReacceptance, lastUpdated, content, contentHash: crypto.createHash('sha256').update(content).digest('hex') };
};

export const currentLegalDocument = async (documentType, config) => legalDocument(documentType, config);

export const legalReadiness = async (config = {}) => {
  const blockers = [];
  const operator = config.operator || {};
  const legal = config.legal || {};
  for (const [key, label] of [['name', 'LEGAL_OPERATOR_NAME'], ['email', 'PLATFORM_OPERATOR_EMAIL'], ['privacyEmail', 'PRIVACY_EMAIL'], ['supportEmail', 'SUPPORT_EMAIL'], ['moderationEmail', 'MODERATION_EMAIL'], ['registeredAddress', 'LEGAL_ADDRESS']]) {
    if (!String(operator[key] || '').trim()) blockers.push(`${label} is not configured.`);
  }
  if (!String(legal.paymentProvider || '').trim()) blockers.push('PAYMENT_PROVIDER is not configured.');
  if (!String(legal.paymentProviderPrivacyUrl || '').trim()) blockers.push('PAYMENT_PROVIDER_PRIVACY_URL is not configured.');
  if (!Array.isArray(legal.subprocessors)) blockers.push('A verified subprocessor inventory is not configured.');
  const rendered = await Promise.all(documents.map((document) => legalDocument(document.slug, config)));
  for (const document of rendered) {
    const placeholders = document.content.match(/\[[A-Z][A-Z0-9 /",_-]+\]/g) || [];
    if (placeholders.length) blockers.push(`${document.title} has unresolved placeholders: ${[...new Set(placeholders)].join(', ')}`);
  }
  if (config.runtime?.paidEventsEnabled && !String(legal.directChargeVerified || '').trim()) blockers.push('Direct-charge payment architecture has not been verified.');
  if (config.runtime?.paidServicesEnabled && !String(legal.withdrawalFunctionUrl || '').trim()) blockers.push('The paid-services withdrawal function is not configured.');
  return { ready: blockers.length === 0, blockers, documents: rendered.map(({ slug, documentType, version, contentHash }) => ({ slug, documentType, version, contentHash })) };
};

export const legalDocuments = () => documents.map((document) => ({ ...document }));
