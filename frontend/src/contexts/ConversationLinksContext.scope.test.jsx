import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CitationChip } from '../components/CitationChip';
import { ConversationLinksProvider, scopeConversationLinks } from './ConversationLinksContext';

it('only opens a citation for the active pane with the matching project root', () => {
  const openFile = vi.fn();
  const active = { root: '/active', openFile };
  const target = { kind: 'file', path: 'src/a.js', line: 12 };
  const view = render(<ConversationLinksProvider value={scopeConversationLinks(active, '/inactive', false)}>
    <CitationChip target={target} label="source" />
  </ConversationLinksProvider>);
  expect(screen.queryByRole('button', { name: 'Open src/a.js at line 12 in Files' })).toBeNull();
  expect(openFile).not.toHaveBeenCalled();

  view.rerender(<ConversationLinksProvider value={scopeConversationLinks(active, '/inactive', true)}>
    <CitationChip target={target} label="source" />
  </ConversationLinksProvider>);
  expect(screen.queryByRole('button', { name: 'Open src/a.js at line 12 in Files' })).toBeNull();

  view.rerender(<ConversationLinksProvider value={scopeConversationLinks(active, '/active', true)}>
    <CitationChip target={target} label="source" />
  </ConversationLinksProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open src/a.js at line 12 in Files' }));
  expect(openFile).toHaveBeenCalledWith('src/a.js', 12);
});


it('routes an inactive pane citation through that pane’s own root and handler', () => {
  const openFile = vi.fn();
  const paneOpenFile = vi.fn();
  const links = { root: '/active', openFile };
  render(<ConversationLinksProvider value={scopeConversationLinks(links, '/other', false, paneOpenFile)}>
    <CitationChip target={{ kind: 'file', path: '/other/src/a.js', line: 12 }} label="source" />
  </ConversationLinksProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open src/a.js at line 12 in Files' }));
  expect(paneOpenFile).toHaveBeenCalledWith('src/a.js', 12);
  expect(openFile).not.toHaveBeenCalled();
});
