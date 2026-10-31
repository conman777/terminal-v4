import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LightweightMarkdown } from './LightweightMarkdown';

const fence = source => `\`\`\`mermaid\n${source}\n\`\`\``;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

describe('expanded diagrams', () => {
  it.each([
    ['graph TD\nA --> B', 'Mermaid flowchart'],
    ['sequenceDiagram\nA->>B: Request', 'Mermaid sequence diagram'],
  ])('opens and closes a supported diagram while retaining its source', (source, label) => {
    render(<LightweightMarkdown content={fence(source)} />);
    const open = screen.getByRole('button', { name: 'Expand diagram' });
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Expanded diagram' });
    expect(within(dialog).getByRole('region', { name: label })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close diagram' })).toHaveFocus();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).toHaveFocus();
    fireEvent.click(screen.getByText('Show diagram source'));
    expect(screen.getByRole('region', { name: 'mermaid code' }).textContent).toBe(source);
  });

  it('does not offer expansion for unsupported or incomplete diagrams', () => {
    const view = render(<LightweightMarkdown content={fence('pie title Example')} />);
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull();
    view.rerender(<LightweightMarkdown content={'```mermaid\ngraph TD\nA --> B'} />);
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull();
  });

  it('dismisses an expanded diagram when its source changes', () => {
    const view = render(<LightweightMarkdown content={fence('graph TD\nA --> B')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    expect(screen.getByRole('dialog', { name: 'Expanded diagram' })).toBeInTheDocument();
    view.rerender(<LightweightMarkdown content={fence('graph TD\nC --> D')} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: 'Flowchart: C to D' })).toBeInTheDocument();
  });
});
