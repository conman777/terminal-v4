import { memo } from 'react';

const LINK_RE = /(https?:\/\/[^\s)]+)|`([^`]+)`/g;
const SAFE_URL_RE = /^https?:\/\//i;
const BULLET_RE = /^\s*[-*\u2022]\s+(.+)$/;
const NUMBERED_RE = /^\s*(\d+)[.)]\s+(.+)$/;
const HEADING_RE = /^(#{1,4})\s+(.+)$/;

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

function normalizeContent(content) {
  return String(content || '')
    .replace(/\r\n?/g, '\n')
    .replace(/([^\n])\s+(?=\u2022\s+)/g, '$1\n');
}

function isBlockStart(line) {
  return (
    /^```(\w+)?\s*$/.test(line)
    || BULLET_RE.test(line)
    || NUMBERED_RE.test(line)
    || HEADING_RE.test(line)
  );
}

function parseBlocks(content) {
  const blocks = [];
  const lines = normalizeContent(content).split('\n');
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

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: Math.min(heading[1].length, 4),
        content: heading[2].trim()
      });
      index += 1;
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(BULLET_RE);
        if (!item) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    const numbered = line.match(NUMBERED_RE);
    if (numbered) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(NUMBERED_RE);
        if (!item) break;
        items.push(item[2].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', content: paragraph.join(' ') });
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

        if (block.type === 'heading') {
          const HeadingTag = `h${block.level}`;
          return (
            <HeadingTag key={index}>
              {renderInline(block.content, linkClassName)}
            </HeadingTag>
          );
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index} className="md-list">
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item.slice(0, 24)}`}>
                  {renderInline(item, linkClassName)}
                </li>
              ))}
            </ListTag>
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
