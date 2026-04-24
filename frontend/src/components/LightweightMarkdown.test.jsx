import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LightweightMarkdown } from './LightweightMarkdown';

describe('LightweightMarkdown', () => {
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
    expect(screen.getByText('const ok = true;')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 16' })).toBeInTheDocument();
    expect(renderCodeActions).toHaveBeenCalledWith('const ok = true;');
  });
});
