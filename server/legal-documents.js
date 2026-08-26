import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const documentDirectory = new URL('./legal-documents/', import.meta.url);

// Only public-facing agreements belong here. Keep implementation notes and
// internal compliance material out of this registry.
const documents = [
  { slug: 'terms', title: 'Terms of Service', file: 'terms.md', version: '2026-08-26' },
  { slug: 'privacy', title: 'Privacy Policy', file: 'privacy.md', version: '2026-08-26' },
  { slug: 'community-guidelines', title: 'Community Guidelines', file: 'community-guidelines.md', version: '2026-08-26' },
  { slug: 'organizer-terms', title: 'Organizer Terms', file: 'organizer-terms.md', version: '2026-08-26' },
  { slug: 'tickets-refunds', title: 'Ticket, Cancellation & Refund Policy', file: 'tickets-refunds.md', version: '2026-08-26' },
  { slug: 'cookies', title: 'Cookie Policy', file: 'cookies.md', version: '2026-08-26' },
];

const publicMetadata = ({ slug, title, version }) => ({ slug, title, version, url: `/api/legal-documents/${slug}`, format: 'markdown' });

export const legalDocumentIndex = () => documents.map(publicMetadata);

const replacementValues = (operator = {}, site = {}, minimumUserAge = 18) => ({
  '[LEGAL COMPANY NAME]': operator.name || '[PLATFORM OPERATOR NAME]',
  '[ORG NUMBER]': operator.organisationNumber || 'Not applicable while the Platform is operated by an individual',
  '[ADDRESS]': operator.registeredAddress || 'Available on request via the support email',
  '[PRIVACY EMAIL]': operator.privacyEmail || operator.email || '[PRIVACY EMAIL]',
  '[SUPPORT EMAIL]': operator.supportEmail || operator.email || '[SUPPORT EMAIL]',
  '[MODERATION EMAIL]': operator.moderationEmail || operator.email || '[MODERATION EMAIL]',
  '[REPORT ILLEGAL CONTENT URL]': `${site.siteUrl || ''}/report`,
  '[REPORT CONTENT URL]': `${site.siteUrl || ''}/report`,
  '[APPEAL URL]': `${site.siteUrl || ''}/appeal`,
  '[PRIVACY REQUEST URL / EMAIL]': operator.privacyEmail || operator.email || '[PRIVACY EMAIL]',
  '[ACCOUNT DELETION URL]': `${site.siteUrl || ''}/settings/privacy`,
  '[COOKIE SETTINGS LINK]': `${site.siteUrl || ''}/cookies`,
  '[MINIMUM AGE]': String(minimumUserAge),
  '[DATE]': '26 August 2026',
});

const renderContent = (content, config) => Object.entries(replacementValues(config?.operator, config?.site, config?.runtime?.minimumUserAge))
  .reduce((rendered, [token, value]) => rendered.replaceAll(token, value), content);

export const legalDocument = async (slug, config = null) => {
  const document = documents.find((candidate) => candidate.slug === slug);
  if (!document) return null;
  const content = renderContent(await readFile(fileURLToPath(new URL(document.file, documentDirectory)), 'utf8'), config);
  const lastUpdated = content.match(/^>\s*Last updated:\s*(.+)$/mi)?.[1]?.trim() || null;
  return { ...publicMetadata(document), version: document.version, lastUpdated, content, contentHash: crypto.createHash('sha256').update(content).digest('hex') };
};

export const currentLegalDocument = async (documentType, config) => legalDocument(documentType, config);
