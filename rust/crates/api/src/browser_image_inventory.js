(() => {
  const result = { images: [], truncated: false };
  const roots = [document];
  const encoder = new TextEncoder();
  let visited = 0;
  while (roots.length && !result.truncated) {
    const walker = document.createTreeWalker(roots.pop(), NodeFilter.SHOW_ELEMENT);
    let element;
    while ((element = walker.nextNode())) {
      if (++visited > 5000) { result.truncated = true; break; }
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (element.tagName !== 'IMG') continue;
      if (result.images.length >= 200) { result.truncated = true; break; }
      const raw = element.currentSrc || element.getAttribute('src') || '';
      const inline = /^data:/i.test(raw);
      let url = null;
      let unavailable;
      if (!inline && raw) {
        if (raw.length > 2048) unavailable = 'too_long';
        else try {
          const parsed = new URL(raw, document.baseURI);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) unavailable = 'unsupported';
          else if (parsed.href.length > 2048) unavailable = 'too_long';
          else url = parsed.href;
        } catch { unavailable = 'invalid'; }
      }
      const row = { url, alt: String(element.getAttribute('alt') || '').slice(0, 600).replace(/\s+/g, ' ').trim().slice(0, 300), inline };
      if (unavailable) row.urlUnavailable = unavailable;
      result.images.push(row);
      if (encoder.encode(JSON.stringify(result)).length > 60000) {
        result.images.pop();
        result.truncated = true;
        break;
      }
    }
  }
  return result;
})()
