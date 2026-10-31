import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LightweightMarkdown } from './LightweightMarkdown';
import { ConversationLinksProvider } from '../contexts/ConversationLinksContext';

afterEach(cleanup);
const fence = (language, code) => '```' + language + '\n' + code + '\n```';
const mermaid = source => fence('mermaid', source);

describe('syntax highlighting', () => {
  it('renders token spans as text while the block text stays exactly the source', () => {
    const code = 'const s = "<img src=x onerror=alert(1)>"; // <script>alert(1)</script>';
    const view = render(<LightweightMarkdown content={fence('ts', code)} />);
    const block = screen.getByRole('region', { name: 'ts code' });
    expect(block.textContent).toBe(code);
    expect(block.querySelectorAll('.tok-keyword, .tok-string, .tok-comment').length).toBe(3);
    expect(view.container.querySelector('img, script')).toBeNull();
  });

  it('leaves unknown languages and over-budget blocks plain and says so for large blocks', () => {
    const big = 'const a = 1;\n'.repeat(3000);
    const view = render(<LightweightMarkdown content={fence('js', big) + '\n\n' + fence('klingon', 'const a = 1')} />);
    expect(view.container.querySelectorAll('.tok')).toHaveLength(0);
    expect(screen.getByText('Large block. Highlighting skipped.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'js code' }).textContent).toBe(big);
  });

  it('keeps a nested longer fence intact and highlights only the outer language', () => {
    const inner = '```js\nconst x = 1;\n```';
    render(<LightweightMarkdown content={'````markdown\n' + inner + '\n````'} />);
    expect(screen.getByRole('region', { name: 'markdown code' }).textContent).toBe(inner);
  });

  it('provides a working copy button when the host supplies none, copying the unhighlighted source', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<LightweightMarkdown content={fence('py', 'def f():\n    return 1')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('def f():\n    return 1');
    expect(await screen.findByText('Copied to clipboard')).toBeVisible();
  });

  it('tokenizes a hundred long adversarial blocks without hanging', () => {
    const content = Array.from({ length: 100 }, () => fence('js', '"\\'.repeat(2000))).join('\n\n');
    const started = performance.now();
    render(<LightweightMarkdown content={content} />);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('citation chips', () => {
  const sources = '\n\n[1]: https://example.test/doc "Example doc"\n[2]: javascript:alert(1)';

  it('turns [n] into a safe external chip and keeps the source list visible', () => {
    render(<LightweightMarkdown content={'Claim [1] and [2] and [9].' + sources} />);
    const chip = screen.getByRole('link', { name: /Source 1: Example doc \(example.test/ });
    expect(chip).toHaveAttribute('href', 'https://example.test/doc');
    expect(chip).toHaveAttribute('target', '_blank');
    expect(chip).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.getByText(/Claim/).textContent).toBe('Claim 1 and [2] and [9].');
  });

  it('renders <cite href> as a chip and unsafe or missing targets as plain cite text', () => {
    const view = render(<LightweightMarkdown content={'See <cite href="https://example.test/a">the docs</cite>, <cite href="javascript:alert(1)">bad</cite>, <cite>plain</cite>.'} />);
    expect(screen.getByRole('link', { name: /the docs/ })).toHaveAttribute('href', 'https://example.test/a');
    expect(view.container.querySelectorAll('cite')).toHaveLength(2);
    expect(view.container.querySelectorAll('a')).toHaveLength(1);
  });

  it('opens a project file at its line from inline code and file: links, with keyboard activation', async () => {
    const openFile = vi.fn();
    render(<ConversationLinksProvider value={{ root: '/work/proj', openFile }}>
      <LightweightMarkdown content={'Look at `src/App.jsx:42` and [handler](file:/work/proj/src/h.js:7) but not `../../etc/passwd:1`, `/etc/hosts:1` or `npm run`.'} />
    </ConversationLinksProvider>);
    const chip = screen.getByRole('button', { name: 'Open src/App.jsx at line 42 in Files' });
    chip.focus();
    await userEvent.keyboard('{Enter}');
    expect(openFile).toHaveBeenLastCalledWith('src/App.jsx', 42);
    fireEvent.click(screen.getByRole('button', { name: 'Open src/h.js at line 7 in Files' }));
    expect(openFile).toHaveBeenLastCalledWith('src/h.js', 7);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('/etc/hosts:1')).not.toHaveAttribute('title', expect.stringContaining('Open'));
    expect(screen.queryByRole('button', { name: /passwd|hosts/ })).toBeNull();
  });

  it('falls back to plain text when no file or thread handler exists or the thread is unknown', () => {
    const view = render(<LightweightMarkdown content={'Code `src/App.jsx:42` and [file](file:src/a.js:1) and [old](thread:gone)'} />);
    expect(view.container.querySelector('code.inline-code')).toHaveTextContent('src/App.jsx:42');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('file')).toHaveClass('md-citation-unavailable');
    view.rerender(<ConversationLinksProvider value={{ openThread: vi.fn(), hasThread: id => id === 'live-1' }}>
      <LightweightMarkdown content={'[old](thread:gone) [new](thread:live-1) [bad](thread:../x)'} />
    </ConversationLinksProvider>);
    expect(screen.getByText('old')).toHaveClass('md-citation-unavailable');
    expect(screen.getByRole('button', { name: 'Open thread: new' })).toBeVisible();
    expect(screen.getByText('bad')).toBeVisible();
  });

  it('navigates to a known thread', () => {
    const openThread = vi.fn();
    render(<ConversationLinksProvider value={{ openThread, hasThread: () => true }}><LightweightMarkdown content="[earlier](thread:abc_1)" /></ConversationLinksProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open thread: earlier' }));
    expect(openThread).toHaveBeenCalledWith('abc_1');
  });

  it('never creates links from script-looking text or javascript: destinations', () => {
    const view = render(<LightweightMarkdown content={'[x](javascript:alert(1)) [1] <cite href="data:text/html,x">d</cite>\n\n[1]: vbscript:x'} />);
    expect(view.container.querySelector('a, button')).toBeNull();
  });
});

describe('image lightbox', () => {
  const content = '![Chart of load](https://example.test/chart.png)';

  it('opens a labelled modal dialog, traps focus, closes with Escape and restores focus', async () => {
    render(<LightweightMarkdown content={content} />);
    const opener = screen.getByRole('button', { name: 'View larger: Chart of load' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Image: Chart of load' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByAltText('Chart of load')).toHaveAttribute('src', 'https://example.test/chart.png');
    const original = within(dialog).getByRole('link', { name: 'Open original' });
    expect(original).toHaveAttribute('rel', 'noopener noreferrer');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(original).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Zoom in' })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('navigates only safe images in this message, resets zoom, and closes on content change', async () => {
    const first = '![First](https://example.test/first.png)\n\n![Bad](data:image/png;base64,AAAA)\n\n![Second](/second.png)';
    const view = render(<><LightweightMarkdown content={first} /><LightweightMarkdown content="![Other](/other.png)" /></>);
    const opener = screen.getByRole('button', { name: 'View larger: First' });
    await userEvent.click(opener);
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('1 of 2')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(within(dialog).getByText('150%')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    dialog = screen.getByRole('dialog', { name: 'Image: Second' });
    expect(within(dialog).getByText('100%')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open original' })).toHaveAttribute('href', '/second.png');
    expect(within(dialog).getByRole('button', { name: 'Next image' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{ArrowLeft}{Escape}');
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    view.rerender(<><LightweightMarkdown content={first + '\n\nChanged'} /><LightweightMarkdown content="![Other](/other.png)" /></>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes from the backdrop and never opens unsafe image sources', async () => {
    const view = render(<LightweightMarkdown content={content + '\n\n![bad](javascript:alert(1))\n\n![data](data:image/png;base64,AAAA)'} />);
    expect(screen.getAllByRole('button', { name: /View larger/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /View larger/ }));
    fireEvent.click(document.querySelector('.md-lightbox'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.container.querySelector('img[src^="javascript"], img[src^="data"]')).toBeNull();
  });
});

describe('mermaid improvements', () => {
  it('draws flowchart cycles with a dashed back edge and says so accessibly', () => {
    const view = render(<LightweightMarkdown content={mermaid('graph TD\nA --> B\nB -->|retry| A\nB --> B')} />);
    expect(screen.getByRole('img', { name: 'Flowchart: A to B; B to A (retry) (loops back); B to B (loops back)' })).toBeVisible();
    expect(view.container.querySelectorAll('path.md-flowchart-back')).toHaveLength(2);
  });

  it('draws horizontal cycles and still bounds the size', () => {
    render(<LightweightMarkdown content={mermaid('flowchart LR\nA --> B\nB --> C\nC --> A')} />);
    expect(screen.getByRole('img', { name: /C to A \(loops back\)/ })).toBeVisible();
    const many = Array.from({ length: 70 }, (_, i) => `N${i} --> N${i + 1}`).join('\n');
    cleanup();
    render(<LightweightMarkdown content={mermaid('graph TD\n' + many)} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Unsupported diagram syntax. Showing source.')).toBeVisible();
  });

  it('labels unsupported and unclosed diagrams while keeping the source readable', () => {
    const source = 'pie title Pets\n"Dogs" : 3';
    render(<LightweightMarkdown content={mermaid(source)} />);
    expect(screen.getByText('Unsupported diagram syntax. Showing source.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe(source);
    cleanup();
    render(<LightweightMarkdown content={'```mermaid\ngraph TD\nA --> B'} />);
    expect(screen.getByText('Diagram is incomplete. Showing source.')).toBeVisible();
  });
});
