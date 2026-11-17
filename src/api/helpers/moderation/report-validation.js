import crypto from 'node:crypto';

export function createModerationReportValidation() {
  const reportEntityTypes = new Set([
    'image',
    'event',
    'group',
    'review',
    'profile',
    'organization',
    'venue',
    'business_listing',
  ]);
  const reportReasonCodes = new Set([
    'illegal_content',
    'harassment',
    'sexual_content',
    'child_safety',
    'violence',
    'hate',
    'scam_fraud',
    'impersonation',
    'privacy',
    'intellectual_property',
    'spam',
    'unsafe_event',
    'misleading_business',
    'misleading_listing',
    'other',
  ]);
  const reportReference = () =>
    `RPT-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  return { reportEntityTypes, reportReasonCodes, reportReference };
}
