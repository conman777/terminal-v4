import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolCallBlock from './ToolCallBlock';

describe('ToolCallBlock', () => {
  it('renders assistant activity as grouped events with raw transcript details', () => {
    render(
      <ToolCallBlock
        item={{
          type: 'assistant_activity',
          content: [
            'Ran npm --prefix frontend test -- --run (ctrl + t to view transcript)',
            'Read frontend/src/styles.css +120 lines',
            'Opened screenshot-2026-05-27T19-03-56.png in browser',
            'Started Vite dev server on http://127.0.0.1:5173',
            'Ran git status -sb',
          ].join('\n'),
        }}
      />
    );

    expect(screen.getByText('Terminal activity')).toBeInTheDocument();
    expect(screen.getByText('Tests & Build')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Browser Check')).toBeInTheDocument();
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.getByText('Git')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));

    expect(screen.getByLabelText('Raw terminal transcript')).toHaveTextContent(
      'Ran npm --prefix frontend test -- --run'
    );
  });
});
