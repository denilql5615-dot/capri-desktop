const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s<>]+?)\)|https?:\/\/[^\s<>"`]+/gi;

export function hubLinks(text) {
  const parts = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    const raw = match[2] || match[0].replace(/[),.;:!?\]»]+$/, '');
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: match[1] || raw, url: url.href });
    at = match.index + (match[2] ? match[0].length : raw.length);
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export function appendHubText(element, text, makeText = (value) => value) {
  for (const part of hubLinks(text)) {
    if (!part.url) {
      element.append(makeText(part.text));
      continue;
    }
    const link = document.createElement('a');
    link.href = part.url;
    link.title = part.url;
    link.append(makeText(part.text));
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await window.host.chatsOpenLink(part.url);
      } catch {
        if (element.querySelector('.hub__link-error')) return;
        const message = document.createElement('span');
        message.className = 'hub__link-error';
        message.setAttribute('role', 'status');
        message.textContent = ' Не удалось открыть ссылку.';
        element.append(message);
      }
    });
    element.append(link);
  }
}
