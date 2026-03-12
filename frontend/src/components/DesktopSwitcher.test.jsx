import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopSwitcher } from './DesktopSwitcher';

function buildDesktops() {
  return [
    { id: 'd1', name: 'Desktop 1', paneLayout: { root: { type: 'pane', id: 'p1', sessionId: null } } },
    { id: 'd2', name: 'Desktop 2', paneLayout: { root: { type: 'pane', id: 'p2', sessionId: 's1' } } },
  ];
}

describe('DesktopSwitcher', () => {
  it('calls onRename when a desktop name is edited via double-click and blur', () => {
    const onRename = vi.fn();
    const desktops = buildDesktops();

    render(
      <DesktopSwitcher
        desktops={desktops}
        activeDesktopId="d1"
        sessions={[]}
        onSwitch={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={onRename}
      />
    );

    const nameSpan = screen.getByText('Desktop 1');
    fireEvent.doubleClick(nameSpan);

    const input = screen.getByDisplayValue('Desktop 1');
    fireEvent.change(input, { target: { value: 'Work' } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith('d1', 'Work');
  });

  it('does not call onRename when the name is unchanged', () => {
    const onRename = vi.fn();
    const desktops = buildDesktops();

    render(
      <DesktopSwitcher
        desktops={desktops}
        activeDesktopId="d1"
        sessions={[]}
        onSwitch={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={onRename}
      />
    );

    const nameSpan = screen.getByText('Desktop 2');
    fireEvent.doubleClick(nameSpan);

    const input = screen.getByDisplayValue('Desktop 2');
    fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
  });

  it('commits edit on Enter key', () => {
    const onRename = vi.fn();
    const desktops = buildDesktops();

    render(
      <DesktopSwitcher
        desktops={desktops}
        activeDesktopId="d1"
        sessions={[]}
        onSwitch={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={onRename}
      />
    );

    const nameSpan = screen.getByText('Desktop 1');
    fireEvent.doubleClick(nameSpan);

    const input = screen.getByDisplayValue('Desktop 1');
    fireEvent.change(input, { target: { value: 'Projects' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('d1', 'Projects');
  });
});
