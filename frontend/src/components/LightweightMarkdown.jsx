import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { MermaidFlowchart, parseFlowchart } from './MermaidFlowchart';
import { MermaidSequence, parseSequence } from './MermaidSequence';
import { HighlightedCode } from './HighlightedCode';
import { CodeCopyButton } from './CodeCopyButton';
import { CitationChip } from './CitationChip';
import { ImageLightbox } from './ImageLightbox';
import { useConversationLinks } from '../contexts/ConversationLinksContext';
import { collectCitationDefinitions, parseCitationTarget, parseFileReference } from '../utils/conversationCitations';
import { HIGHLIGHT_MAX_CHARS, highlightLanguage } from '../utils/syntaxHighlight';
import { projectFileReference } from '../utils/projectFileReference';
import './LightweightMarkdown.css';

const LINK_RE = /(`+)|\[([^\]]+)\]\(|\*\*([^*]+)\*\*|(https?:\/\/)|(?<![\\$])\$(?!\$)|\[(\d{1,3})\](?![(\[:])|<cite(?:\s+href="([^"<>]{1,500})")?>([^<]{1,200})<\/cite>/g;
const SAFE_URL_RE = /^https?:\/\//i;
const HEADING_RE = /^(#{1,4})\s+(.+)$/;
const FENCE_RE = /^(`{3,}|~{3,})([\w.+#-]*)[ \t]*$/;
const DEFINITION_RE = /^\[(\d{1,3})\]:[ \t]+(\S{1,2048})(?:[ \t]+"([^"]{0,200})")?[ \t]*$/;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;
const DETAILS_RE = /^<details(?:[ \t]+(open)(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s>]+))?)?[ \t]*>(?:[ \t]*<summary>(.*?)<\/summary>)?[ \t]*$/i;
const INLINE_DETAILS_RE = /^<details(?:[ \t]+(open)(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s>]+))?)?[ \t]*>[ \t]*<summary>(.*?)<\/summary>(.*?)<\/details>[ \t]*$/i;
const SUMMARY_RE = /^<summary>(.*?)<\/summary>[ \t]*$/i;
const safeUrl = href => SAFE_URL_RE.test(href) || /^\/(?![\\/])/.test(href);

function mathMarkup(content, displayMode) {
  if (!content || content.length > 4096) return null;
  try {
    return katex.renderToString(content, { displayMode, throwOnError: true, trust: false, maxSize: 10, maxExpand: 100 });
  } catch { return null; }
}

function mathSpan(text, start) {
  if (/\s/.test(text[start + 1] || '') || !text[start + 1]) return null;
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] !== '$' || text[index + 1] === '$') continue;
    if (/\s/.test(text[index - 1]) || /\d/.test(text[index + 1] || '')) return null;
    return { content: text.slice(start + 1, index), end: index + 1 };
  }
  return null;
}

function codeSpan(text, start) {
  const delimiter = text.slice(start).match(/^`+/)?.[0];
  if (!delimiter) return null;
  const runs = /`+/g;
  runs.lastIndex = start + delimiter.length;
  let match;
  while ((match = runs.exec(text))) {
    if (match[0] === delimiter) return { content: text.slice(start + delimiter.length, match.index), end: runs.lastIndex };
  }
  return null;
}

function linkDestination(text, start, explicit) {
  let href = '', depth = 0, index = start;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (/\s|</.test(character)) break;
    if (character === '\\' && /[\\()]/.test(text[index + 1] || '')) {
      href += text[++index];
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      if (depth === 0) {
        if (explicit) return { href, end: index + 1, suffix: '' };
        break;
      }
      depth -= 1;
    }
    href += character;
  }
  if (explicit) return null;
  return { href: href.replace(/[.,;:!]+$/, ''), end: index, suffix: href.match(/[.,;:!]+$/)?.[0] || '' };
}

function InlineCode({ content }) {
  const links = useConversationLinks();
  const reference = links?.openFile ? parseFileReference(content) : null;
  if (reference) return <CitationChip target={{ kind: 'file', ...reference }} label={content} />;
  return <code className="inline-code">{content}</code>;
}

function renderInline(text, linkClassName, options = {}) {
  if (!text) return null;

  const parts = [];
  let lastIndex = 0;
  LINK_RE.lastIndex = 0;

  let match;
  while ((match = LINK_RE.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    let end = LINK_RE.lastIndex;
    if (match[0] === '$') {
      const span = mathSpan(text, match.index);
      const markup = span && mathMarkup(span.content, false);
      parts.push(markup ? <span key={match.index} className="md-math-inline" dangerouslySetInnerHTML={{ __html: markup }} /> : span ? text.slice(match.index, span.end) : '$');
      if (span) end = span.end;
    } else if (match[1]) {
      const span = codeSpan(text, match.index);
      parts.push(span ? <InlineCode key={match.index} content={span.content} /> : match[0]);
      if (span) end = span.end;
    } else if (match[3]) {
      parts.push(<strong key={match.index}>{match[3]}</strong>);
    } else if (match[5]) {
      const definition = options.definitions?.get(match[5]);
      const target = definition && parseCitationTarget(definition.url);
      parts.push(target ? <CitationChip key={match.index} target={target} label={match[5]} title={definition.title} /> : match[0]);
    } else if (match[7]) {
      const target = match[6] && parseCitationTarget(match[6]);
      parts.push(target ? <CitationChip key={match.index} target={target} label={match[7]} /> : <cite key={match.index}>{match[7]}</cite>);
    } else {
      const destination = linkDestination(text, match[2] ? end : match.index, Boolean(match[2]));
      if (destination) {
        const { href, suffix } = destination;
        const special = match[2] && /^(thread|file):/i.test(href) ? parseCitationTarget(href) : null;
        const file = match[2] && options.workspacePath ? projectFileReference(href, options.workspacePath) : null;
        parts.push(file
          ? options.onFileClick
            ? <button key={match.index} type="button" className="md-file-link" aria-label={`Open ${match[2]} at line ${file.line}`} onClick={event => { event.stopPropagation(); options.onFileClick(file); }}>{match[2]}</button>
            : <span key={match.index}>{match[2]}</span>
          : special ? <CitationChip key={match.index} target={special} label={match[2]} /> : safeUrl(href)
          ? <a key={match.index} href={href} target="_blank" rel="noopener noreferrer" className={linkClassName}>{match[2] || href}</a>
          : <span key={match.index}>{match[2] || href}</span>);
        if (suffix) parts.push(suffix);
        end = destination.end;
      } else parts.push(match[0]);
    }

    lastIndex = end;
    LINK_RE.lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

function closesFence(line, fence) {
  const closing = line.match(/^(`{3,}|~{3,})[ \t]*$/)?.[1];
  return Boolean(closing && closing[0] === fence[0] && closing.length >= fence.length);
}

function tableCells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function isTableStart(line, nextLine = '') {
  const headers = tableCells(line);
  const separators = tableCells(nextLine);
  return headers.length > 1 && headers.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(line, nextLine) {
  return (
    /^\s*\$\$/.test(line)
    || isTableStart(line, nextLine)
    || IMAGE_RE.test(line)
    || DEFINITION_RE.test(line)
    || /^>\s?/.test(line)
    || FENCE_RE.test(line)
    || Boolean(listMarker(line))
    || HEADING_RE.test(line)
    || DETAILS_RE.test(line.trim())
    || INLINE_DETAILS_RE.test(line.trim())
  );
}

function indentation(text) {
  return [...text].reduce((width, character) => width + (character === '\t' ? 4 - width % 4 : 1), 0);
}

function listMarker(line) {
  const match = line.match(/^([ \t]*)([-+*\u2022]|\d+[.)])([ \t]+)(.*)$/);
  if (!match) return null;
  return { indent: indentation(match[1]), contentIndent: indentation(match[1] + match[2] + match[3]),
    ordered: /^\d/.test(match[2]), start: Number.parseInt(match[2], 10), content: match[4] };
}

function removeIndent(line, width) {
  let index = 0, columns = 0;
  while (index < line.length && columns < width) {
    columns += line[index] === '\t' ? 4 - columns % 4 : 1;
    index += 1;
  }
  return ' '.repeat(Math.max(0, columns - width)) + line.slice(index);
}

function parseList(lines, startIndex, depth) {
  const first = listMarker(lines[startIndex]);
  const items = [];
  let index = startIndex, loose = false;
  while (index < lines.length) {
    const marker = listMarker(lines[index]);
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
    const task = marker.content.match(/^\[([ xX])\](?:[ \t]+|$)/);
    const itemLines = [task ? marker.content.slice(task[0].length) : marker.content];
    index += 1;
    let blanks = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { blanks += 1; index += 1; continue; }
      const next = listMarker(line);
      if (next && next.indent === first.indent) {
        if (blanks && next.ordered === first.ordered) loose = true;
        break;
      }
      if (indentation(line.match(/^[ \t]*/)[0]) < marker.contentIndent) break;
      if (blanks) { loose = true; itemLines.push(...Array(blanks).fill('')); blanks = 0; }
      itemLines.push(removeIndent(line, marker.contentIndent));
      index += 1;
    }
    items.push({ blocks: parseBlocks(itemLines.join('\n'), depth), checked: task ? task[1].toLowerCase() === 'x' : null });
  }
  return { block: { type: 'list', ordered: first.ordered, start: first.start, items, loose }, index };
}

function parseDetails(lines, startIndex, depth) {
  const opening = lines[startIndex].trim().match(DETAILS_RE);
  if (!opening || depth >= 8) return null;
  let nesting = 1, fence = null;
  const limit = Math.min(lines.length, startIndex + 2048);
  for (let index = startIndex + 1; index < limit; index += 1) {
    const line = lines[index].trim();
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const startFence = line.match(FENCE_RE);
    if (startFence) { fence = startFence[1]; continue; }
    if (DETAILS_RE.test(line)) {
      nesting += 1;
      if (depth + nesting > 8) return null;
    } else if (/^<details(?:[ \t]|>)/i.test(line) && !INLINE_DETAILS_RE.test(line)) {
      return null;
    } else if (/^<\/details>[ \t]*$/i.test(line) && --nesting === 0) {
      let bodyStart = startIndex + 1;
      while (bodyStart < index && !lines[bodyStart].trim()) bodyStart += 1;
      const summary = opening[2] === undefined && lines[bodyStart]?.trim().match(SUMMARY_RE);
      if (summary) bodyStart += 1;
      return {
        block: { type: 'details', open: Boolean(opening[1]), summary: opening[2] || summary?.[1] || 'Details', blocks: parseBlocks(lines.slice(bodyStart, index).join('\n'), depth + 1) },
        index: index + 1,
      };
    }
  }
  return null;
}

function parseBlocks(content, depth = 0) {
  const blocks = [];
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(FENCE_RE);

    if (fence) {
      const language = fence[2] || 'text';
      const code = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index], fence[1])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'code', language, content: code.join('\n'), closed: index < lines.length });
      index += 1;
      continue;
    }

    const singleMath = line.trim().match(/^\$\$(.+)\$\$$/);
    if (singleMath) {
      blocks.push({ type: 'math', content: singleMath[1] });
      index += 1;
      continue;
    }
    if (line.trim() === '$$') {
      const close = lines.findIndex((candidate, position) => position > index && candidate.trim() === '$$');
      if (close !== -1) {
        blocks.push({ type: 'math', content: lines.slice(index + 1, close).join('\n') });
        index = close + 1;
        continue;
      }
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const inlineDetails = depth < 8 && line.trim().match(INLINE_DETAILS_RE);
    if (inlineDetails) {
      blocks.push({ type: 'details', open: Boolean(inlineDetails[1]), summary: inlineDetails[2] || 'Details', blocks: parseBlocks(inlineDetails[3], depth + 1) });
      index += 1;
      continue;
    }
    if (DETAILS_RE.test(line.trim())) {
      const details = parseDetails(lines, index, depth);
      if (details) { blocks.push(details.block); index = details.index; continue; }
    }

    if (isTableStart(line, lines[index + 1])) {
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const definition = line.match(DEFINITION_RE);
    if (definition) {
      blocks.push({ type: 'definition', label: definition[1], url: definition[2], title: definition[3] || '' });
      index += 1;
      continue;
    }

    const image = line.match(IMAGE_RE);
    if (image) {
      blocks.push({ type: 'image', alt: image[1], src: image[2] });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      const alert = depth < 8 && quote[0].match(ALERT_RE);
      if (alert) blocks.push({ type: 'alert', kind: alert[1].toLowerCase(), blocks: parseBlocks(quote.slice(1).join('\n'), depth + 1) });
      else blocks.push({ type: 'quote', content: quote.join(' ') });
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

    if (listMarker(line)) {
      const list = parseList(lines, index, depth);
      blocks.push(list.block);
      index = list.index;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index], lines[index + 1])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', content: paragraph.join(' ') });
  }

  return blocks;
}

function MarkdownImage({ src, alt, content }) {
  const [failed, setFailed] = useState(false);
  const [gallery, setGallery] = useState(null);
  useEffect(() => { setGallery(null); }, [content]);
  if (!safeUrl(src)) return <p>{alt || 'Image unavailable'}</p>;
  return (
    <figure className="md-image">
      {failed ? <span className="md-image-fallback">Image unavailable: {alt || 'Image'}</span>
        : <button type="button" className="md-image-open" aria-haspopup="dialog" aria-label={`View larger: ${alt || 'Image'}`} onClick={event => {
          const buttons = [...event.currentTarget.closest('.lightweight-markdown').querySelectorAll('.md-image-open')].filter(button => !button.closest('details:not([open])') && safeUrl(button.querySelector('img')?.getAttribute('src') || ''));
          const items = buttons.map(button => { const image = button.querySelector('img'); return { src: image.getAttribute('src'), alt: image.alt }; });
          setGallery({ content, items, index: buttons.indexOf(event.currentTarget) });
        }}>
          <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        </button>}
      {alt && <figcaption>{alt}</figcaption>}
      {gallery?.content === content && <ImageLightbox items={gallery.items} initialIndex={gallery.index} onClose={() => setGallery(null)} />}
    </figure>
  );
}

function ExpandedDiagram({ source, isFlowchart, onClose }) {
  const dialogRef = useRef(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog.showModal();
    dialog.querySelector('button')?.focus();
    return () => {
      const restoreFocus = dialog.contains(document.activeElement);
      if (dialog.open) dialog.close();
      if (restoreFocus && opener?.isConnected && !opener.closest('[inert], [hidden], [aria-hidden="true"]')) opener.focus();
    };
  }, []);
  const Diagram = isFlowchart ? MermaidFlowchart : MermaidSequence;
  return <dialog ref={dialogRef} className="md-diagram-dialog" aria-label="Expanded diagram" aria-modal="true" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="md-diagram-dialog-header"><span>Diagram <small>Scroll to explore</small></span><button type="button" onClick={onClose} aria-label="Close diagram">Close</button></header>
    <Diagram source={source} />
  </dialog>;
}

function ExpandDiagramButton({ source, isFlowchart }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <button type="button" className="md-diagram-expand" aria-haspopup="dialog" onClick={() => setExpanded(true)}>Expand diagram</button>
    {expanded && <ExpandedDiagram source={source} isFlowchart={isFlowchart} onClose={() => setExpanded(false)} />}
  </>;
}

function renderBlocks(blocks, options, tight = false) {
  const { linkClassName, codeClassName, renderCodeActions } = options;

  return blocks.map((block, index) => {
    if (block.type === 'math') {
      const markup = mathMarkup(block.content, true);
      return markup ? <div key={index} className="md-math-block" role="region" aria-label="Math expression" tabIndex={0} data-conversation-scroll-region dangerouslySetInnerHTML={{ __html: markup }} />
        : <pre key={index} className="md-math-fallback">{`$$\n${block.content}\n$$`}</pre>;
    }
    if (block.type === 'code') {
      const isFlowchart = block.closed && block.language.toLowerCase() === 'mermaid' && parseFlowchart(block.content);
      const isSequence = block.closed && block.language.toLowerCase() === 'mermaid' && !isFlowchart && parseSequence(block.content);
      const language = block.language.toLowerCase();
      const unrendered = language === 'mermaid' && !isFlowchart && !isSequence;
      const tooLarge = highlightLanguage(language) && block.content.length > HIGHLIGHT_MAX_CHARS;
      const source = <pre className={codeClassName} tabIndex={0} role="region" aria-label={`${block.language} code`} data-conversation-scroll-region><HighlightedCode content={block.content} language={language} /></pre>;
      return (
        <div key={index} className="code-block-wrapper md-code-block">
          <div className="md-code-toolbar">
            <span className="md-code-language">{block.language}</span>
            {unrendered && <span className="md-code-note">{block.closed ? 'Unsupported diagram syntax. Showing source.' : 'Diagram is incomplete. Showing source.'}</span>}
            {tooLarge && <span className="md-code-note">Large block. Highlighting skipped.</span>}
            {(isFlowchart || isSequence) && <ExpandDiagramButton key={block.content} source={block.content} isFlowchart={!!isFlowchart} />}
            {renderCodeActions ? renderCodeActions(block.content) : <CodeCopyButton text={block.content} />}
          </div>
          {isFlowchart && <MermaidFlowchart source={block.content} />}
          {isSequence && <MermaidSequence source={block.content} />}
          {isFlowchart || isSequence ? <details className="md-diagram-source"><summary>Show diagram source</summary>{source}</details> : source}
        </div>
      );
    }

    if (block.type === 'definition') {
      const target = parseCitationTarget(block.url);
      return <p key={index} className="md-source"><span className="md-source-number">[{block.label}]</span>{' '}
        {target ? <CitationChip target={target} label={block.title || block.url} title={block.title} /> : <span>{block.title ? `${block.title} ` : ''}{block.url}</span>}</p>;
    }

    if (block.type === 'table') {
      return <div className="md-table-scroll" role="region" aria-label="Markdown table" tabIndex={0} data-conversation-scroll-region key={index}><table className="md-table">
        <thead><tr>{block.headers.map((cell, column) => <th key={column} scope="col">{renderInline(cell, linkClassName, options)}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.headers.map((_, column) => <td key={column}>{renderInline(row[column] || '', linkClassName, options)}</td>)}</tr>)}</tbody>
      </table></div>;
    }
    if (block.type === 'image') return <MarkdownImage key={`${index}-${block.src}`} src={block.src} alt={block.alt} content={options.content} />;
    if (block.type === 'details') return <details className="md-details" key={index} open={block.open || undefined}>
      <summary>{renderInline(block.summary, linkClassName, options)}</summary>
      <div className="md-details-content">{renderBlocks(block.blocks, options)}</div>
    </details>;
    if (block.type === 'quote') return <blockquote className="md-blockquote" key={index}>{renderInline(block.content, linkClassName, options)}</blockquote>;
    if (block.type === 'alert') return <div className={`md-alert md-alert-${block.kind}`} key={index}>
      <p className="md-alert-title">{block.kind[0].toUpperCase() + block.kind.slice(1)}</p>
      {renderBlocks(block.blocks, options)}
    </div>;
    if (block.type === 'heading') {
      const HeadingTag = `h${block.level}`;
      return (
        <HeadingTag key={index}>
          {renderInline(block.content, linkClassName, options)}
        </HeadingTag>
      );
    }

    if (block.type === 'list') {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag key={index} className="md-list" start={block.ordered ? block.start : undefined}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex} className={item.checked !== null ? 'md-task-item' : undefined}>
              {item.checked !== null && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Completed task' : 'Incomplete task'} />}
              {renderBlocks(item.blocks, options, !block.loose)}
            </li>
          ))}
        </ListTag>
      );
    }

    if (tight) return <Fragment key={index}>{renderInline(block.content, linkClassName, options)}</Fragment>;
    return (
      <p key={index}>
        {renderInline(block.content, linkClassName, options)}
      </p>
    );
  });
}

export const LightweightMarkdown = memo(function LightweightMarkdown({
  content,
  linkClassName,
  codeClassName = 'lazy-syntax-fallback',
  renderCodeActions,
  workspacePath,
  onFileClick,
}) {
  if (!content) return null;
  const blocks = parseBlocks(content);
  return (
    <div className="lightweight-markdown">
      {renderBlocks(blocks, { content, linkClassName, codeClassName, renderCodeActions, workspacePath, onFileClick, definitions: collectCitationDefinitions(blocks) })}
    </div>
  );
});
