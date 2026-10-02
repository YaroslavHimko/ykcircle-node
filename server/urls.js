// Build links without discarding deployment query parameters or fragments.
export function webUrl(value, label = 'URL') {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label} must be an HTTP(S) URL without embedded credentials.`);
  return url;
}

export function actionUrl(base, { path = [], query = {} } = {}) {
  const url = webUrl(base);
  if (path.length) url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.map(value => encodeURIComponent(String(value))).join('/')}`;
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url.href;
}
