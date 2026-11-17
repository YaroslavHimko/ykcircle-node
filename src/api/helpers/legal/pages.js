import { escapeHtml } from './html.js';
export function createLegalPages({ config }) {
  const companyInformation = () => {
    const operator = config.operator || {};
    return {
      legalOperatorName: operator.name || null,
      registeredAddress: operator.registeredAddress || null,
      supportEmail: operator.supportEmail || operator.email || null,
      privacyEmail: operator.privacyEmail || operator.email || null,
      moderationEmail: operator.moderationEmail || operator.email || null,
      country: operator.country || null,
    };
  };
  const publishedSubprocessors = () =>
    Array.isArray(config.legal?.subprocessors) ? config.legal.subprocessors : [];
  const publicFooter =
    '<footer><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a><a href="/community-guidelines">Community Guidelines</a><a href="/report">Report</a><a href="/appeal">Appeal</a><a href="/contact">Contact</a><a href="/operator">Operator information</a><a href="/subprocessors">Service providers</a></footer>';
  const publicPage = (title, body) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(config.site.brandName)}</title><style>body{font-family:system-ui,sans-serif;line-height:1.55;margin:0;color:#172033;background:#f7f8fa}main{max-width:840px;margin:2rem auto;padding:2rem;background:#fff;border-radius:12px}footer{display:flex;flex-wrap:wrap;gap:1rem;margin-top:3rem;padding-top:1rem;border-top:1px solid #ddd}label,input,select,textarea,button{display:block;width:100%;box-sizing:border-box;margin:.5rem 0}input,select,textarea,button{padding:.7rem}textarea{min-height:9rem}</style></head><body><main>${body}${publicFooter}</main></body></html>`;
  return { companyInformation, publishedSubprocessors, publicPage };
}
