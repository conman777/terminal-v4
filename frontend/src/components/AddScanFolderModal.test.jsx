import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddScanFolderModal } from './AddScanFolderModal';

describe('AddScanFolderModal', () => {
  it('names the path field, trims the submitted path, and keeps backend errors available', () => {
    const onSubmit = vi.fn();
    render(<AddScanFolderModal isOpen error="Synthetic folder unavailable" onSubmit={onSubmit} />);
    const path = screen.getByRole('textbox', { name: 'Project path' });
    expect(path).toHaveAccessibleDescription('Enter an absolute project path to add it to the sidebar.');
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeDisabled();
    fireEvent.change(path, { target: { value: '  /fixture/project  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('/fixture/project');
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic folder unavailable');
    expect(path).toHaveValue('  /fixture/project  ');
  });

  it('blocks repeated submission while adding the project', () => {
    const onSubmit = vi.fn();
    render(<AddScanFolderModal isOpen isLoading onSubmit={onSubmit} />);
    expect(screen.getByRole('textbox', { name: 'Project path' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Adding...' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
