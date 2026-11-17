export const escapeHtml = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
export const legalHtml = (markdown) => {
  const html = [];
  let listOpen = false;
  let codeLines = null;
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    if (rawLine.startsWith('```')) {
      closeList();
      if (codeLines) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = null;
      } else codeLines = [];
      continue;
    }
    if (codeLines) {
      codeLines.push(rawLine);
      continue;
    }
    const line = escapeHtml(rawLine).replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/gi,
      '<a href="$2">$1</a>',
    );
    if (line.startsWith('# ')) {
      closeList();
      html.push(`<h1>${line.slice(2)}</h1>`);
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      html.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }
    if (line.startsWith('### ')) {
      closeList();
      html.push(`<h3>${line.slice(4)}</h3>`);
      continue;
    }
    if (line.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${line.slice(2)}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) html.push(`<p>${line.replace(/^&gt;\s?/, '')}</p>`);
  }
  closeList();
  if (codeLines) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return html.join('\n');
};
