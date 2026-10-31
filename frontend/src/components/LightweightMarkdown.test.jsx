import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LightweightMarkdown } from './LightweightMarkdown';
import ToolCallBlock from './ToolCallBlock';
import userEvent from '@testing-library/user-event';

function ownText(item) {
  const copy = item.cloneNode(true);
  copy.querySelectorAll('ul, ol').forEach(list => list.remove());
  return copy.textContent;
}

describe('LightweightMarkdown', () => {
  it('opens project file references while keeping external links as links', () => {
    const onFileClick = vi.fn();
    render(<LightweightMarkdown content={'[Source](/work/project/src/app.js:12) and [range](src/app.js#L9-L15) and [outside](https://example.test/page) and [invalid](../secret.txt).'} workspacePath="/work/project" onFileClick={onFileClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Source at line 12' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open range at line 9' }));
    expect(onFileClick.mock.calls).toEqual([[{ path: 'src/app.js', line: 12 }], [{ path: 'src/app.js', line: 9 }]]);
    expect(screen.getByRole('link', { name: 'outside' })).toHaveAttribute('href', 'https://example.test/page');
    expect(screen.queryByRole('button', { name: /invalid/i })).toBeNull();
  });

  it('renders expandable sections with formatted content and preserves their state during streaming', () => {
    const source = 'Before\n<details>\n<summary>Review **details**</summary>\n\n- First\n- Second\n\n```js\nconst done = true;\n```\n</details>\nAfter';
    const view = render(<LightweightMarkdown content={source} />);
    const summary = screen.getByText('Review', { exact: false }).closest('summary');
    const details = summary.closest('details');
    expect(summary).toHaveTextContent('Review details');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('First')).toBeInTheDocument();
    expect(within(details).getByRole('region', { name: 'js code', hidden: true })).toHaveTextContent('const done = true;');
    details.open = true;
    view.rerender(<LightweightMarkdown content={`${source}\nMore arrives.`} />);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('After More arrives.')).toBeInTheDocument();
  });

  it('supports nested and initially open sections without executing HTML, and leaves incomplete sections as text', () => {
    const source = '<details open>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\n<img src="https://invalid.test/pixel" onerror="alert(1)">\n\n</details>\n\n</details>';
    const view = render(<LightweightMarkdown content={source} />);
    const outer = screen.getByText('Outer').closest('details');
    const inner = screen.getByText('Inner').closest('details');
    expect(outer).toHaveAttribute('open');
    expect(inner).not.toHaveAttribute('open');
    expect(outer).toContainElement(inner);
    expect(inner).toHaveTextContent('<img src="https://invalid.test/pixel" onerror="alert(1)">');
    expect(view.container.querySelector('img')).toBeNull();
    view.rerender(<LightweightMarkdown content={'<details>\n<summary>Still streaming</summary>\nUnfinished'} />);
    expect(view.container.querySelector('details')).toBeNull();
    expect(view.container).toHaveTextContent('<details>');
    expect(view.container).toHaveTextContent('Unfinished');
  });

  it('keeps closing tags in fenced examples and accepts a summary beside the opening tag', () => {
    const source = '<details><summary>Example</summary>\n\n```html\n</details>\n```\n\nAfter the example.\n</details>\n\nOutside.';
    const view = render(<LightweightMarkdown content={source} />);
    const details = screen.getByText('Example').closest('details');
    expect(within(details).getByRole('region', { name: 'html code', hidden: true })).toHaveTextContent('</details>');
    expect(within(details).getByText('After the example.')).toBeInTheDocument();
    expect(screen.getByText('Outside.').parentElement).toHaveClass('lightweight-markdown');
    view.rerender(<LightweightMarkdown content={'```html\n<details>\n<summary>literal</summary>\n</details>\n```'} />);
    expect(view.container.querySelector('.md-details')).toBeNull();
    expect(screen.getByRole('region', { name: 'html code' })).toHaveTextContent('<summary>literal</summary>');
  });

  it('accepts a single-line section and HTML boolean open values', () => {
    render(<LightweightMarkdown content={'<details open="true"><summary>Short</summary>**Done**</details>'} />);
    const details = screen.getByText('Short').closest('details');
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText('Done').tagName).toBe('STRONG');
  });

  it('keeps malformed nested disclosure markup literal instead of misplacing the outer body', () => {
    const content = '<details>\n<summary>Outer</summary>\n\n<details onclick="alert(1)">\n<summary>Inner</summary>\n\nInside\n\n</details>\n\nStill inside\n\n</details>';
    const view = render(<LightweightMarkdown content={content} />);
    expect(view.container.querySelector('.md-details')).toBeNull();
    expect(view.container).toHaveTextContent('Still inside');
    expect(view.container).toHaveTextContent('<details onclick="alert(1)">');
  });

  it('renders inline and block math accessibly while leaving code and currency literal', () => {
    const view = render(<LightweightMarkdown content={'The formula is $E=mc^2$. Price: $5 and $10.\n\n$$\n\\frac{1}{2}\n$$\n\n`$x$`\n\n```tex\n$x$\n```'} />);
    expect(view.container.querySelectorAll('.katex-mathml math')).toHaveLength(2);
    expect(screen.getByText('The formula is', { exact: false })).toBeVisible();
    expect(view.container.textContent).toContain('Price: $5 and $10.');
    expect(view.container.querySelector('code.inline-code')).toHaveTextContent('$x$');
    expect(screen.getByRole('region', { name: 'tex code' })).toHaveTextContent('$x$');
  });

  it('shows invalid math as literal text and does not enable unsafe TeX HTML commands', () => {
    const view = render(<LightweightMarkdown content={'$\\badcommand$ and $\\includegraphics{https://example.test/x.png}$'} />);
    expect(view.container.textContent).toContain('\\badcommand');
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('a')).toBeNull();
  });

  it('renders a supported Mermaid flowchart as an accessible diagram and preserves its source', () => {
    render(<LightweightMarkdown content={'```mermaid\ngraph TD\nA-->B\n```'} />);
    expect(screen.getByRole('img', { name: /Flowchart/ })).toBeInTheDocument();
    expect(screen.getByText('A', { selector: 'text' })).toBeInTheDocument();
    expect(screen.getByText('B', { selector: 'text' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Show diagram source'));
    expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe('graph TD\nA-->B');
  });

  it('keeps unsupported or hostile Mermaid source as code without external resources or executable markup', () => {
    const source = 'graph TD\nA["<img src=https://example.test/x onerror=alert(1)>"] --> B\nclick A "https://example.test"';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe(source);
    expect(view.container.querySelector('img, iframe, script, a')).toBeNull();
  });

  it('treats markup in supported node labels as inert text', () => {
    const source = 'graph TD\nA["<img src=https://example.test/x>"] --> B';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('img', { name: /<img src=https:\/\/example.test\/x> to B/ })).toBeInTheDocument();
    expect(view.container.querySelector('img, iframe, script, a')).toBeNull();
  });

  it('treats markup in edge labels as text without executing or loading it', () => {
    const source = 'flowchart TD\nA -->|<img src=https://example.test/x>| B';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('img', { name: /<img src=https:\/\/example.test\/x>/ })).toBeVisible();
    expect(view.container.querySelector('img, iframe, script, a')).toBeNull();
  });

  it('renders labelled left-to-right branching flowcharts', () => {
    const view = render(<LightweightMarkdown content={'```mermaid\nflowchart LR\nstart[Start] --> ready{Ready}\nready -->|Yes| done[Done]\nready -->|No| stop[Stop]\n```'} />);
    expect(screen.getByRole('img', { name: 'Flowchart: Start to Ready; Ready to Done (Yes); Ready to Stop (No)' })).toBeVisible();
    expect(screen.getByText('Ready', { selector: 'text' })).toBeVisible();
    expect(screen.getByText('Yes', { selector: 'text' })).toBeVisible();
    expect(view.container.querySelector('polygon')).not.toBeNull();
    view.rerender(<LightweightMarkdown content={'```mermaid\nflowchart LR\nstart[Start] --> ready[Ready]\nready --> done[Done]\nready --> stop[Stop]\n```'} />);
    expect(screen.getByRole('img', { name: 'Flowchart: Start to Ready; Ready to Done; Ready to Stop' })).toBeVisible();
  });

  it('renders bounded sequence messages with accessible participant labels and preserves the source', () => {
    const source = 'sequenceDiagram\nparticipant A as Client\nparticipant B as Server\nA->>B: Request\nB-->>A: Response';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('img', { name: 'Sequence diagram: Client to Server: Request; Server to Client: Response' })).toBeVisible();
    expect(view.container.querySelector('line.md-sequence-reply[stroke-dasharray="5 4"]')).not.toBeNull();
    fireEvent.click(screen.getByText('Show diagram source'));
    expect(screen.getByRole('region', { name: 'mermaid code' })).toHaveTextContent(source.replaceAll('\n', ' '));
  });

  it('renders sequence notes over one or two participants as inert accessible text', () => {
    const source = 'sequenceDiagram\nparticipant A as Client\nparticipant B as Server\nA->>B: Request\nNote over A,B: Awaiting <img src=https://example.test/x>\nB-->>A: Response\nNote over A: Complete';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('img', { name: 'Sequence diagram: Client to Server: Request; Note over Client, Server: Awaiting <img src=https://example.test/x>; Server to Client: Response; Note over Client: Complete' })).toBeVisible();
    expect(view.container.querySelectorAll('.md-sequence-note')).toHaveLength(2);
    expect(view.container.querySelector('img, iframe, script, a')).toBeNull();
    fireEvent.click(screen.getByText('Show diagram source'));
    expect(screen.getByRole('region', { name: 'mermaid code' })).toHaveTextContent(source.replaceAll('\n', ' '));
  });

  it('renders a sequence containing a note without requiring a message', () => {
    render(<LightweightMarkdown content={'```mermaid\nsequenceDiagram\nparticipant A as Client\nNote over A: Waiting\n```'} />);
    expect(screen.getByRole('img', { name: 'Sequence diagram: Note over Client: Waiting' })).toBeVisible();
  });

  it('leaves unsupported or over-budget sequence notes as source', () => {
    const view = render(<LightweightMarkdown content={'```mermaid\nsequenceDiagram\nA->>B: Request\nNote left of A: Not yet supported\n```'} />);
    expect(screen.getByRole('region', { name: 'mermaid code' })).toBeVisible();
    const source = 'sequenceDiagram\nA->>B: Request\n' + Array.from({ length: 64 }, () => 'Note over A: Waiting').join('\n');
    view.rerender(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe(source);
    expect(view.container.querySelector('svg')).toBeNull();
  });

  it('keeps unsupported sequence constructs as source and treats message markup as inert text', () => {
    const hostile = 'sequenceDiagram\nA->>B: <img src=https://example.test/x>';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + hostile + '\n```'} />);
    expect(screen.getByRole('img', { name: /<img src=https:\/\/example.test\/x>/ })).toBeVisible();
    expect(view.container.querySelector('img, iframe, script, a')).toBeNull();
    view.rerender(<LightweightMarkdown content={'```mermaid\nsequenceDiagram\nA->>B: Hello\nalt Again\nB->>A: Reply\nend\n```'} />);
    expect(screen.getByRole('region', { name: 'mermaid code' })).toBeVisible();
    expect(view.container.querySelector('svg')).toBeNull();
  });

  it('renders bounded nested sequence loops with accessible labels and preserved source', () => {
    const source = 'sequenceDiagram\nparticipant A as Client\nparticipant B as Server\nloop Retry\nA->>B: Request\nloop Backoff\nNote over A,B: Wait\nB-->>A: Response\nend\nend';
    const view = render(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
    expect(screen.getByRole('img', { name: 'Sequence diagram: Loop: Retry; Client to Server: Request; Loop: Backoff; Note over Client, Server: Wait; Server to Client: Response; End loop; End loop' })).toBeVisible();
    expect(view.container.querySelectorAll('.md-sequence-loop')).toHaveLength(2);
    expect(screen.getByText('Loop: Retry', { selector: 'text' })).toBeVisible();
    expect(screen.getByText('Loop: Backoff', { selector: 'text' })).toBeVisible();
    fireEvent.click(screen.getByText('Show diagram source'));
    expect(screen.getByRole('region', { name: 'mermaid code' })).toHaveTextContent(source.replaceAll('\n', ' '));
  });

  it('keeps incomplete, unmatched, empty and over-nested sequence loops as source', () => {
    const sources = [
      'sequenceDiagram\nloop Retry\nA->>B: Request',
      'sequenceDiagram\nA->>B: Request\nend',
      'sequenceDiagram\nloop Retry\nend\nA->>B: Request',
      'sequenceDiagram\n' + 'loop Again\n'.repeat(5) + 'A->>B: Request\n' + 'end\n'.repeat(5),
    ];
    const view = render(<LightweightMarkdown content={'```mermaid\n' + sources[0] + '\n```'} />);
    for (const source of sources) {
      view.rerender(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
      expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe(source);
      expect(view.container.querySelector('svg')).toBeNull();
    }
  });

  it('clips wide loop labels to their own header while preserving full accessible text', () => {
    const label = 'W'.repeat(70) + '界';
    const source = `sequenceDiagram\nparticipant A\nloop ${label}\nA->>A: Work\nend`;
    const view = render(<><LightweightMarkdown content={'```mermaid\n' + source + '\n```'} /><LightweightMarkdown content={'```mermaid\n' + source + '\n```'} /></>);
    expect(screen.getAllByRole('img', { name: `Sequence diagram: Loop: ${label}; A to A: Work; End loop` })).toHaveLength(2);
    const headers = [...view.container.querySelectorAll('.md-sequence-loop-label')];
    expect(headers).toHaveLength(2);
    const clips = headers.map(header => header.getAttribute('clip-path'));
    expect(clips[0]).toMatch(/^url\(#sequence-arrow-[\w-]+-loop-0\)$/);
    expect(clips[0]).not.toBe(clips[1]);
    for (const header of headers) {
      const id = header.getAttribute('clip-path').slice(5, -1);
      const clip = view.container.querySelector(`clipPath[id="${id}"] rect`);
      const background = header.previousElementSibling;
      expect(Number(clip.getAttribute('width'))).toBeLessThanOrEqual(Number(background.getAttribute('width')));
    }
  });

  it('renders self messages and keeps over-budget sequence diagrams as source', () => {
    const view = render(<LightweightMarkdown content={'```mermaid\nsequenceDiagram\nA->>A: Local work\n```'} />);
    expect(screen.getByRole('img', { name: 'Sequence diagram: A to A: Local work' })).toBeVisible();
    for (const source of [
      'sequenceDiagram\n' + Array.from({ length: 17 }, (_, i) => `participant P${i}`).join('\n') + '\nP0->>P1: Hello',
      'sequenceDiagram\n' + Array.from({ length: 65 }, () => 'A->>B: Hello').join('\n'),
      'sequenceDiagram\nA->>B: ' + 'x'.repeat(8192),
    ]) {
      view.rerender(<LightweightMarkdown content={'```mermaid\n' + source + '\n```'} />);
      expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe(source);
      expect(view.container.querySelector('svg')).toBeNull();
    }
  });

  it('keeps incomplete, escaped and over-budget math literal', () => {
    const source = 'Escaped \\$x$; unfinished $x; oversized $' + 'a'.repeat(4097) + '$.';
    const view = render(<LightweightMarkdown content={source} />);
    expect(view.container.querySelectorAll('.katex')).toHaveLength(0);
    expect(view.container.textContent).toBe(source);
  });

  it('keeps an unfinished Mermaid fence as source while streaming', () => {
    render(<LightweightMarkdown content={'```mermaid\ngraph TD\nA-->'} />);
    expect(screen.queryByTitle('Mermaid diagram')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'mermaid code' })).toHaveTextContent('graph TD A-->');
  });
  it('preserves a literal bullet inside a Markdown link label without inventing a list', () => {
    const view = render(<LightweightMarkdown content={'Read [left • right](https://example.test/a_(b)).'} />);
    expect(screen.getByRole('link', { name: 'left • right' })).toHaveAttribute('href', 'https://example.test/a_(b)');
    expect(view.container.querySelectorAll('p')).toHaveLength(1);
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
    expect(view.container.textContent).toBe('Read left • right.');
  });

  it.each(['```', '~~~'])('preserves literal indented %s delimiters and subsequent code in both rendering and clipboard copy', async fence => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const code = '    ' + fence + '\nconst label = "left • right";';
    const view = render(<ToolCallBlock item={{ type: 'assistant', content: fence + 'markdown\n' + code + '\n' + fence + '\nDone.' }} />);
    expect([...view.container.querySelectorAll('pre code')].map(node => node.textContent)).toEqual([code]);
    await user.click(screen.getByRole('button', { name: 'Copy code', exact: true }));
    expect(write.mock.calls).toEqual([[code]]);
    expect(screen.getByText('Done.').tagName).toBe('P');
    write.mockRestore();
  });

  it('keeps a mid-line bullet after inline code literal instead of inventing a list', () => {
    const view = render(<LightweightMarkdown content={'`left • right` • Next step'} />);
    expect([...view.container.querySelectorAll('code')].map(node => node.textContent)).toEqual(['left • right']);
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
    expect(view.container.textContent).toBe('left • right • Next step');
  });

  it.each(['`left • right`', '``left ` • right``'])('preserves inline code and surrounding literal prose bullets: %s', token => {
    const code = token.startsWith('``') ? 'left ` • right' : 'left • right';
    const view = render(<LightweightMarkdown content={'Use ' + token + ' as the exact label. • First • Second'} />);
    expect([...view.container.querySelectorAll('code')].map(node => node.textContent)).toEqual([code]);
    expect(view.container.querySelectorAll('li')).toHaveLength(0);
    expect(screen.getByText(/^Use /).textContent).toBe('Use ' + code + ' as the exact label. • First • Second');
  });

  it('preserves a list-owned fence and its copy bytes when the fence follows the marker directly', () => {
    const code = 'const label = "left • right";\n  // • preserve spaces';
    const actions = vi.fn(() => null);
    const view = render(<LightweightMarkdown content={'- ```js\n  ' + code.replaceAll('\n', '\n  ') + '\n  ```\n- Next step'} renderCodeActions={actions} />);
    expect([...view.container.querySelectorAll('pre code')].map(node => node.textContent)).toEqual([code]);
    expect(actions.mock.calls).toEqual([[code]]);
    expect(view.container.querySelector('ul').children).toHaveLength(2);
  });

  it.each([
    ['Read [Function](https://en.wikipedia.org/wiki/Function_(mathematics)).', 'Function', 'https://en.wikipedia.org/wiki/Function_(mathematics)', 'Read Function.'],
    ['Read [Nested](https://example.test/a_(b_(c))).', 'Nested', 'https://example.test/a_(b_(c))', 'Read Nested.'],
    ['Read [Escaped](https://example.test/a_\\(b\\)).', 'Escaped', 'https://example.test/a_(b)', 'Read Escaped.'],
    ['See (https://en.wikipedia.org/wiki/Function_(mathematics)).', 'https://en.wikipedia.org/wiki/Function_(mathematics)', 'https://en.wikipedia.org/wiki/Function_(mathematics)', 'See (https://en.wikipedia.org/wiki/Function_(mathematics)).'],
  ])('preserves balanced or escaped destination parentheses: %s', (content, label, href, text) => {
    const view = render(<LightweightMarkdown content={content} />);
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    expect(view.container.textContent).toBe(text);
  });

  it('keeps mixed nested lists inside their owning items and preserves ordered starts', () => {
    const view = render(<LightweightMarkdown content={'3. Inspect\n   - Read `layout.css`\n     7. Check phone\n     8. Check desktop\n   - Review errors\n4. Share\n\nOutside the list.'} />);
    const outer = view.container.querySelector('.lightweight-markdown > ol');
    expect(outer).toHaveAttribute('start', '3');
    expect([...outer.children].map(ownText)).toEqual(['Inspect', 'Share']);
    const children = outer.firstElementChild.querySelector(':scope > ul');
    expect([...children.children].map(ownText)).toEqual(['Read layout.css', 'Review errors']);
    const steps = children.firstElementChild.querySelector(':scope > ol');
    expect([steps.getAttribute('start'), [...steps.children].map(item => item.textContent)]).toEqual(['7', ['Check phone', 'Check desktop']]);
    expect(screen.getByText('layout.css').tagName).toBe('CODE');
    expect(screen.getByText('Outside the list.').parentElement).toHaveClass('lightweight-markdown');
  });

  it('keeps indented continuation paragraphs and nested code with the correct list item', () => {
    const code = 'const label = "left • right";\n\tkeepIndent();';
    const actions = vi.fn(() => null);
    const view = render(<LightweightMarkdown content={'- Prepare\n  wrapped detail\n\n  A separate **paragraph**.\n\n  ```js\n  ' + code.replaceAll('\n', '\n  ') + '\n  ```\n\n  - Verify\n\n- Finish\n\nOutside.'} renderCodeActions={actions} />);
    const list = view.container.querySelector('.lightweight-markdown > ul');
    const first = list.firstElementChild;
    expect([...first.children].map(node => [node.tagName, node.textContent])).toEqual([
      ['P', 'Prepare wrapped detail'], ['P', 'A separate paragraph.'], ['DIV', 'js' + code], ['UL', 'Verify'],
    ]);
    expect([...list.children].map(item => item.lastChild.textContent)).toEqual(['Verify', 'Finish']);
    expect(actions).toHaveBeenCalledWith(code);
    expect(screen.getByText('Outside.').parentElement).toHaveClass('lightweight-markdown');
  });

  it.each(['  ', '\t'])('preserves Unicode bullet nesting with %j indentation while the response streams', indent => {
    const view = render(<LightweightMarkdown content={'• Parent\n' + indent + '• Child'} />);
    expect(view.container.querySelectorAll('ul > li > ul > li')).toHaveLength(1);
    view.rerender(<LightweightMarkdown content={'• Parent\n' + indent + '• Child\n' + indent + '• Next child\n• Sibling'} />);
    const outer = view.container.querySelector('.lightweight-markdown > ul');
    expect([...outer.children].map(ownText)).toEqual(['Parent', 'Sibling']);
    expect([...outer.firstElementChild.querySelector('ul').children].map(item => item.textContent)).toEqual(['Child', 'Next child']);
  });

  it('keeps adjacent unordered and ordered lists separate at the same indentation', () => {
    const view = render(<LightweightMarkdown content={'- First\n  - Child\n2. Second\n   - Other child'} />);
    expect([...view.container.firstElementChild.children].map(list => [list.tagName, list.children.length])).toEqual([['UL', 1], ['OL', 1]]);
    expect(screen.getAllByRole('list')).toHaveLength(4);
  });

  it('returns an indented paragraph to its parent after a nested list without stealing the following prose', () => {
    const view = render(<LightweightMarkdown content={'- Parent\n  + Child\n\n  Back to the parent.\n- Sibling\n\nFollowing prose.'} />);
    const outer = view.container.querySelector('.lightweight-markdown > ul');
    expect([...outer.firstElementChild.children].map(node => [node.tagName, node.textContent])).toEqual([
      ['P', 'Parent'], ['UL', 'Child'], ['P', 'Back to the parent.'],
    ]);
    expect(outer.children).toHaveLength(2);
    expect(screen.getByText('Following prose.').parentElement).toHaveClass('lightweight-markdown');
  });

  it('keeps sentence punctuation outside bare URLs without changing explicit link targets', () => {
    render(<LightweightMarkdown content={'See https://example.test/docs. Then https://example.test/help, or [exact](https://example.test/file.).'} />);
    expect(screen.getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['https://example.test/docs', 'https://example.test/docs'],
      ['https://example.test/help', 'https://example.test/help'],
      ['exact', 'https://example.test/file.'],
    ]);
    expect(screen.getByText(/^See /).textContent).toBe('See https://example.test/docs. Then https://example.test/help, or exact.');
  });

  it.each(['````', '~~~'])('preserves nested code examples and copy bytes in a %s fence', fence => {
    const code = '# Example\n```js\nconst label = "left • right";\n```\nAfter • keep this code';
    const actions = vi.fn(() => null);
    render(<LightweightMarkdown content={fence + 'markdown\n' + code + '\n' + fence + '\n\nAfter the example.'} renderCodeActions={actions} />);
    expect(screen.getAllByRole('region').map(region => [region.getAttribute('aria-label'), region.textContent])).toEqual([['markdown code', code]]);
    expect(actions).toHaveBeenCalledWith(code);
    expect(screen.getByText('After the example.').tagName).toBe('P');
  });

  it('keeps a shorter fence inside a streamed code example until the matching close arrives', () => {
    const code = '```js\nconst ready = true;\n```';
    const view = render(<LightweightMarkdown content={'````markdown\n' + code} />);
    expect(screen.getByRole('region', { name: 'markdown code' }).textContent).toBe(code);
    view.rerender(<LightweightMarkdown content={'````markdown\n' + code + '\n`````\nDone.'} />);
    expect(screen.getByRole('region', { name: 'markdown code' }).textContent).toBe(code);
    expect(screen.getByText('Done.').tagName).toBe('P');
  });

  it('separates prose from a table without leading pipes and preserves ordered list numbering', () => {
    render(<LightweightMarkdown content={'Results\nName | State\n--- | ---\nBuild | Passed\n\n4. Review\n5. Share'} />);
    expect(screen.getByText('Results').tagName).toBe('P');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Passed' })).toBeVisible();
    expect(screen.getByRole('list')).toHaveAttribute('start', '4');
  });

  it('labels code languages and preserves punctuated language fences and copy bytes', () => {
    const code = 'int main() { return 0; }';
    const actions = vi.fn(() => null);
    render(<LightweightMarkdown content={'```c++\n' + code + '\n```'} renderCodeActions={actions} />);
    expect(screen.getByText('c++')).toBeVisible();
    expect(screen.getByText(code).tagName).toBe('CODE');
    expect(actions).toHaveBeenCalledWith(code);
  });

  it('renders quotes and safe image previews with a source link and readable load failure', () => {
    render(<LightweightMarkdown content={'> Keep the original\n> and review carefully.\n\n![Layout](https://example.com/layout.png)\n\n![Unsafe](javascript:alert)'} />);
    expect(screen.getByText('Keep the original and review carefully.').tagName).toBe('BLOCKQUOTE');
    const image = screen.getByRole('img', { name: 'Layout' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(screen.getByRole('button', { name: 'View larger: Layout' })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('img', { name: 'Unsafe' })).not.toBeInTheDocument();
    fireEvent.error(image);
    expect(screen.getByText('Image unavailable: Layout')).toBeVisible();
  });

  it('renders GitHub alerts with structured content while retaining safe link handling', () => {
    const actions = vi.fn(() => null);
    const view = render(<LightweightMarkdown content={'> [!WARNING]\n> Review **carefully** and [open](https://example.test/review); [unsafe](javascript:alert).\n>\n> - First check\n> - Second check\n>\n> ```sh\n> echo safe\n> ```\n\n> [!UNKNOWN]\n> Ordinary quote'} renderCodeActions={actions} />);
    const alert = view.container.querySelector('.md-alert-warning');
    expect(alert).toHaveTextContent('Warning');
    expect(alert.querySelector('strong')).toHaveTextContent('carefully');
    expect(within(alert).getByRole('link', { name: 'open' })).toHaveAttribute('href', 'https://example.test/review');
    expect(within(alert).queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument();
    expect(within(alert).getAllByRole('listitem').map(item => item.textContent)).toEqual(['First check', 'Second check']);
    expect(within(alert).getByRole('region', { name: 'sh code' })).toHaveTextContent('echo safe');
    expect(actions).toHaveBeenCalledWith('echo safe');
    expect(view.container.querySelector('.md-blockquote')).toHaveTextContent('[!UNKNOWN] Ordinary quote');
  });

  it('shows read-only task-list status, including nested tasks, without changing transcript text', () => {
    const view = render(<LightweightMarkdown content={'- [x] Done\n- [ ] Next\n  - [X] Nested\n- [maybe] Literal'} />);
    const checks = screen.getAllByRole('checkbox');
    expect(checks.map(input => [input.checked, input.disabled])).toEqual([[true, true], [false, true], [true, true]]);
    fireEvent.click(checks[1]);
    expect(checks[1]).not.toBeChecked();
    expect(view.container.querySelector('.md-list')).toHaveTextContent('[maybe] Literal');
  });

  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('renders the %s alert title', kind => {
    const view = render(<LightweightMarkdown content={`> [!${kind}]\n> Detail`} />);
    expect(view.container.querySelector(`.md-alert-${kind.toLowerCase()}`)).toHaveTextContent(`${kind[0]}${kind.slice(1).toLowerCase()}Detail`);
  });

  it('keeps alert markers in fenced code and incomplete markers as literal text', () => {
    const view = render(<LightweightMarkdown content={'```markdown\n> [!WARNING]\n> - [x] literal\n```\n\n> [!WARNING]'} />);
    expect(view.container.querySelector('pre code')).toHaveTextContent('> [!WARNING] > - [x] literal');
    expect(view.container.querySelectorAll('.md-alert')).toHaveLength(1);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    view.rerender(<LightweightMarkdown content={'> [!WARN'} />);
    expect(view.container.querySelector('.md-blockquote')).toHaveTextContent('[!WARN');
  });
  it('preserves fenced code and Copy bytes between lists with line-start Unicode bullets', () => {
    const code = 'const label = "left • right";\n  // • keep indentation\n\nconst next = "x • y";';
    const actions = vi.fn(() => null);
    const view = render(<LightweightMarkdown content={'Summary\n• first\n• second\n\n```js\n' + code + '\n```\nAfter\n• third\n• fourth'} renderCodeActions={actions} />);
    expect([view.container.querySelector('pre code').textContent, actions.mock.calls.at(-1)[0], [...view.container.querySelectorAll('li')].map(node => node.textContent)])
      .toEqual([code, code, ['first', 'second', 'third', 'fourth']]);
  });
  it('formats report tables, emphasis and named file links while rejecting unsafe links', () => {
    render(<LightweightMarkdown content={'**Findings**\n\n| Priority | Finding |\n| --- | --- |\n| High | Read [App.jsx](/work/App.jsx) |\n\n[Unsafe](javascript:alert)'} />);
    expect(screen.getByText('Findings').tagName).toBe('STRONG');
    expect(screen.getByRole('columnheader', { name: 'Priority' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'App.jsx' })).toHaveAttribute('href', '/work/App.jsx');
    expect(screen.queryByRole('link', { name: 'Unsafe' })).not.toBeInTheDocument();
  });

  it('renders paragraphs, inline code, links, and fenced code without external markdown packages', () => {
    const renderCodeActions = vi.fn((code) => (
      <button type="button">Copy {code.length}</button>
    ));

    render(
      <LightweightMarkdown
        content={'Open `config` at https://example.com\n\n```js\nconst ok = true;\n```'}
        linkClassName="md-link"
        renderCodeActions={renderCodeActions}
      />
    );

    expect(screen.getByText('config')).toHaveClass('inline-code');
    expect(screen.getByRole('link', { name: 'https://example.com' })).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByRole('region', { name: 'js code' })).toHaveTextContent('const ok = true;');
    expect(screen.getByRole('button', { name: 'Copy 16' })).toBeInTheDocument();
    expect(renderCodeActions).toHaveBeenCalledWith('const ok = true;');
  });

  it('renders line-start transcript bullets as a readable list', () => {
    render(
      <LightweightMarkdown
        content={'Result summary.\n\u2022 Wrapped terminal output\n\u2022 Review `styles.css` next'}
        linkClassName="md-link"
      />
    );

    expect(screen.getByText('Result summary.')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('Wrapped terminal output')).toBeInTheDocument();
    expect(screen.getByText('styles.css')).toHaveClass('inline-code');
  });

  it('renders numbered markdown lines as an ordered list', () => {
    render(
      <LightweightMarkdown
        content={'1. First fix\n2. Second fix'}
        linkClassName="md-link"
      />
    );

    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getByText('First fix')).toBeInTheDocument();
    expect(screen.getByText('Second fix')).toBeInTheDocument();
  });
});
