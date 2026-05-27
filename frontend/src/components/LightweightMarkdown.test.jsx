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

  it('renders transcript bullet lines as a readable list', () => {
    render(
      <LightweightMarkdown
        content={'Result summary. \u2022 Wrapped terminal output \u2022 Review `styles.css` next'}
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
