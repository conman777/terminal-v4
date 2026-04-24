import { memo } from 'react';

const LINK_RE = /(https?:\/\/[^\s)]+)|`([^`]+)`/g;
const SAFE_URL_RE = /^https?:\/\//i;

function renderInline(text, linkClassName) {
  if (!text) return null;

  const parts = [];
  let lastIndex = 0;
  LINK_RE.lastIndex = 0;

  for (const match of text.matchAll(LINK_RE)) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      const href = match[1];
      parts.push(
        <a
          key={`${match.index}-${href}`}
          href={SAFE_URL_RE.test(href) ? href : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClassName}
        >
          {href}
        </a>
      );
    } else {
      parts.push(
        <code key={`${match.index}-${match[2]}`} className="inline-code">
          {match[2]}
        </code>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

function parseBlocks(content) {
  const blocks = [];
  const lines = String(content || '').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^```(\w+)?\s*$/);

    if (fence) {
      const language = fence[1] || 'text';
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'code', language, content: code.join('\n') });
      index += 1;
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```(\w+)?\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', content: paragraph.join('\n') });
  }

  return blocks;
}

export const LightweightMarkdown = memo(function LightweightMarkdown({
  content,
  linkClassName,
  codeClassName = 'lazy-syntax-fallback',
  renderCodeActions
}) {
  if (!content) return null;

  return (
    <>
      {parseBlocks(content).map((block, index) => {
        if (block.type === 'code') {
          return (
            <div key={index} className="code-block-wrapper">
              {renderCodeActions?.(block.content)}
              <pre className={codeClassName}>
                <code>{block.content}</code>
              </pre>
            </div>
          );
        }

        return (
          <p key={index}>
            {renderInline(block.content, linkClassName)}
          </p>
        );
      })}
    </>
  );
});
