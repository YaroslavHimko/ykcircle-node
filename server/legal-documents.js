import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const documentDirectory = new URL('./legal-documents/', import.meta.url);

// Only public-facing agreements belong here. Keep implementation notes and
// internal compliance material out of this registry.
const documents = [
  { slug: 'terms', documentType: 'terms', title: 'Terms of Service', file: '01_TERMS_OF_SERVICE.md', version: '2026-10-02', requiresReacceptance: true },
  { slug: 'privacy', documentType: 'privacy', title: 'Privacy Policy', file: '02_PRIVACY_POLICY.md', version: '2026-10-02', requiresReacceptance: false },
  { slug: 'community-guidelines', documentType: 'community_guidelines', title: 'Community Guidelines', file: '03_COMMUNITY_GUIDELINES.md', version: '2026-10-02', requiresReacceptance: false },
  { slug: 'cookies', documentType: 'cookie_policy', title: 'Cookie & Browser Storage Policy', file: '08_COOKIE_AND_SIMILAR_TECHNOLOGIES_POLICY.md', version: '2026-10-02', requiresReacceptance: false },
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
  return {
    '[LEGAL OPERATOR NAME]': configured(operator.name, 'Operator identity not yet provided'),
    '[OPERATOR COUNTRY]': configured(operator.country, 'Sweden'),
    '[REGISTERED ADDRESS]': configured(operator.registeredAddress, 'Postal contact address not yet provided'),
    '[PRIVACY EMAIL]': privacyEmail,
    '[SUPPORT EMAIL]': supportEmail,
    '[MODERATION EMAIL]': configured(operator.moderationEmail || operator.email, 'Moderation contact not yet provided'),
    '[REPORT URL]': siteUrl + '/report',
    '[APPEAL URL]': siteUrl + '/appeal',
    '[ACCOUNT DELETION URL]': siteUrl + '/profile',
    '[COOKIE SETTINGS LINK]': siteUrl + '/cookies',
    '[PRIVACY POLICY URL]': siteUrl + '/privacy',
    '[SUBPROCESSOR LIST URL]': siteUrl + '/subprocessors',
    '[ACTUAL ANALYTICS PROVIDERS OR "NONE"]': configured(legal.analyticsProviders, 'None configured'),
    '[ACTUAL MARKETING PROVIDERS OR "NONE"]': configured(legal.marketingProviders, 'None configured'),
    '[COOKIE INVENTORY]': configured(legal.cookieInventory, 'No additional storage inventory has been supplied.'),
    '[MAPS PRIVACY DESCRIPTION]': config.runtime?.maps?.enabled
      ? 'Google Maps is available for location search and display. Loading it shares technical information, such as your IP address, and searches you enter with Google. ' + (config.runtime.maps.requiresConsent ? 'The site asks for your external-media choice before loading embedded maps. ' : 'Maps are configured to load when the location feature is used. ') + 'See [Google privacy information](https://policies.google.com/privacy). Browser permission is required before a feature can obtain your precise device location.'
      : 'Embedded external maps are currently disabled. Opening an external map link takes you to the provider website.',
    '[RESET RETENTION DAYS]': String(config.runtime?.retention?.passwordResetDays || 7),
    '[VERIFICATION RETENTION DAYS]': String(config.runtime?.retention?.verificationTokenDays || 30),
    '[INVITATION RETENTION DAYS]': String(config.runtime?.retention?.invitationDays || 30),
    '[MINIMUM AGE]': String(minimumUserAge),
  };
};

const contactLink = (value) => {
  const text = String(value);
  if (/^https?:\/\/[^\s]+$/i.test(text) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    const href = (text.includes('://') ? text : `mailto:${text}`).replace(/[()[\]]/g, character => `%${character.charCodeAt(0).toString(16)}`);
    return `[${text.replace(/[\[\]]/g, '')}](${href})`;
  }
  return text;
};
const renderContent = (content, config) => Object.entries(replacementValues(config))
  .reduce((rendered, [token, value]) => rendered.replaceAll(token, () => contactLink(value)), content);

export const legalDocument = async (slug, config = {}) => {
  config ||= {};
  const document = documents.find((candidate) => candidate.slug === slug || candidate.documentType === slug);
  if (!document) return null;
  const content = renderContent(await readFile(fileURLToPath(new URL(document.file, documentDirectory)), 'utf8'), config);
  const lastUpdated = content.match(/^>\s*Last updated:\s*(.+)$/mi)?.[1]?.trim() || null;
  return { ...publicMetadata(document), version: document.version, requiresReacceptance: document.requiresReacceptance, lastUpdated, content, contentHash: crypto.createHash('sha256').update(content).digest('hex') };
};

export const currentLegalDocument = async (documentType, config) => legalDocument(documentType, config);

export const legalReadiness = async (config = {}) => {
  const blockers = [];
  const warnings = [];
  const operator = config.operator || {};
  const legal = config.legal || {};
  for (const [key, label] of [['name', 'LEGAL_OPERATOR_NAME'], ['email', 'PLATFORM_OPERATOR_EMAIL'], ['privacyEmail', 'PRIVACY_EMAIL'], ['supportEmail', 'SUPPORT_EMAIL'], ['moderationEmail', 'MODERATION_EMAIL'], ['registeredAddress', 'LEGAL_ADDRESS']]) {
    if (!String(operator[key] || '').trim()) blockers.push(`${label} is not configured.`);
  }
  const placeholder = /example|sample|demo|not yet|not currently|to be confirmed/i;
  for (const key of ['name', 'registeredAddress']) if (placeholder.test(String(operator[key] || ''))) blockers.push('Replace sample operator ' + key + '.');
  if (!Array.isArray(legal.subprocessors) || !legal.subprocessors.length) blockers.push('An accurate service-provider inventory is not configured.');
  else for (const provider of legal.subprocessors) {
    if (!provider || typeof provider !== 'object' || !provider.name || !provider.purpose || placeholder.test(provider.name)) blockers.push('Each service provider needs its actual name and purpose.');
    if (!provider?.region || placeholder.test(provider.region)) warnings.push('Confirm processing locations for ' + (provider?.name || 'each provider') + '.');
    if (!provider?.transferSafeguards || placeholder.test(provider.transferSafeguards)) warnings.push('Confirm transfer arrangements for ' + (provider?.name || 'each provider') + '.');
  }
  if (config.runtime?.maps?.enabled && !config.runtime.maps.requiresConsent) blockers.push('Optional embedded maps must require the external-media choice.');
  const rendered = await Promise.all(documents.map((document) => legalDocument(document.slug, config)));
  for (const document of rendered) {
    const placeholders = document.content.match(/\[[A-Z][A-Z0-9 /",_-]+\]/g) || [];
    if (placeholders.length) blockers.push(`${document.title} has unresolved placeholders: ${[...new Set(placeholders)].join(', ')}`);
  }
  return { ready: blockers.length === 0 && warnings.length === 0, blockers, warnings, documents: rendered.map(({ slug, documentType, version, contentHash }) => ({ slug, documentType, version, contentHash })) };
};

// Provider-review gaps remain visible without making every API endpoint unavailable.
export const checkLegalStartup = async (config, logger = console) => {
  const readiness = await legalReadiness(config);
  logger.info('Legal readiness:', { ready: readiness.ready, blockerCount: readiness.blockers.length, warningCount: readiness.warnings.length });
  if (readiness.warnings.length) logger.warn('Legal review outstanding:', readiness.warnings);
  if (config.runtime?.legalRequireReady && readiness.blockers.length) throw new Error(`Legal launch readiness failed: ${readiness.blockers.join(' ')}`);
  return readiness;
};

export const legalDocuments = () => documents.map((document) => ({ ...document }));
