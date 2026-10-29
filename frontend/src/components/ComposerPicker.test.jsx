import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerPicker } from './ComposerPicker';

const options = [{ value: '/first', label: 'First project', description: '/first' }, { value: '/second', label: 'Second project', description: '/second' }];

describe('ComposerPicker', () => {
  it('closes an open menu when disabled and prevents changing its selection', () => {
    const onChange = vi.fn();
    const view = render(<ComposerPicker label="Project" value="/first" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    view.rerender(<ComposerPicker label="Project" value="/first" options={options} onChange={onChange} disabled />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('preserves a pointer selection when the browser blurs without a next focus target', () => {
    const onChange = vi.fn();
    render(<ComposerPicker label="Project" value="/first" options={options} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    const selected = screen.getByRole('menuitemradio', { name: /First project/ });
    fireEvent.blur(selected, { relatedTarget: null });
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Second project/ }));
    expect(onChange).toHaveBeenCalledWith('/second');
  });

  it('selects an option with the keyboard and returns focus to the trigger', () => {
    const onChange = vi.fn();
    render(<ComposerPicker label="Project" value="/first" options={options} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Project' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: /First project/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: /Second project/ })).toHaveFocus();
    fireEvent.click(document.activeElement);
    expect(onChange).toHaveBeenCalledWith('/second');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape and uses the add-project action when there are no projects', () => {
    const action = vi.fn();
    const view = render(<ComposerPicker label="Project" value="/first" options={options} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    view.rerender(<ComposerPicker label="Project" options={[]} placeholder="Choose project" action={{ label: 'Add project', onClick: action }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('shows a visible prefix on the trigger while keeping the accessible name and menu labels unchanged', () => {
    render(<ComposerPicker label="Agent reasoning effort" menuTitle="Reasoning" displayPrefix="Reasoning: " value="xhigh"
      options={[{ value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra high' }]} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Agent reasoning effort' });
    expect(trigger).toHaveTextContent('Reasoning: Extra high');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitemradio', { name: 'Extra high' })).toHaveAttribute('aria-checked', 'true');
  });
});
