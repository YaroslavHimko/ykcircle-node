import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const documentDirectory = new URL('./legal-documents/', import.meta.url);

// Only public-facing agreements belong here. Keep implementation notes and
// internal compliance material out of this registry.
const documents = [
  { slug: 'terms', title: 'Terms of Service', file: 'terms.md' },
  { slug: 'privacy', title: 'Privacy Policy', file: 'privacy.md' },
  { slug: 'community-guidelines', title: 'Community Guidelines', file: 'community-guidelines.md' },
  { slug: 'organizer-terms', title: 'Organizer Terms', file: 'organizer-terms.md' },
  { slug: 'tickets-refunds', title: 'Ticket, Cancellation & Refund Policy', file: 'tickets-refunds.md' },
  { slug: 'cookies', title: 'Cookie Policy', file: 'cookies.md' },
];

const publicMetadata = ({ slug, title }) => ({ slug, title, url: `/api/legal-documents/${slug}`, format: 'markdown' });

export const legalDocumentIndex = () => documents.map(publicMetadata);

export const legalDocument = async (slug) => {
  const document = documents.find((candidate) => candidate.slug === slug);
  if (!document) return null;
  const content = await readFile(fileURLToPath(new URL(document.file, documentDirectory)), 'utf8');
  const lastUpdated = content.match(/^>\s*Last updated:\s*(.+)$/mi)?.[1]?.trim() || null;
  return { ...publicMetadata(document), lastUpdated, content };
};
