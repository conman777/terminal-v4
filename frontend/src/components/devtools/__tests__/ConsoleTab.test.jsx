import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConsoleTab } from '../ConsoleTab';

describe('ConsoleTab', () => {
  const mockLogs = [
    {
      id: 1,
      level: 'log',
      message: 'Test log message',
      timestamp: Date.now()
    },
    {
      id: 2,
      level: 'warn',
      message: 'Warning message',
      timestamp: Date.now() + 100
    },
    {
      id: 3,
      level: 'error',
      message: 'Error message',
      stack: 'Error: Test error\n    at test.js:10:5',
      timestamp: Date.now() + 200
    },
    {
      id: 4,
      level: 'info',
      message: 'Info message',
      timestamp: Date.now() + 300
    },
    {
      id: 5,
      level: 'debug',
      message: 'Debug message',
      timestamp: Date.now() + 400
    }
  ];

  let mockOnClear;
  let mockOnEvaluate;

  beforeEach(() => {
    mockOnClear = vi.fn();
    mockOnEvaluate = vi.fn().mockResolvedValue(undefined);
  });

  it('should render console logs', () => {
    render(<ConsoleTab logs={mockLogs} onClear={mockOnClear} />);

    expect(screen.getByText('Test log message')).toBeInTheDocument();
    expect(screen.getByText('Warning message')).toBeInTheDocument();
    expect(screen.getByText('Error message')).toBeInTheDocument();
  });

  it('should filter logs by level', () => {
    render(<ConsoleTab logs={mockLogs} onClear={mockOnClear} />);

    // Click on "Errors" filter
    const errorFilter = screen.getByText('Errors');
    fireEvent.click(errorFilter);

    // Should only show error logs
    expect(screen.getByText('Error message')).toBeInTheDocument();
    expect(screen.queryByText('Test log message')).not.toBeInTheDocument();
    expect(screen.queryByText('Warning message')).not.toBeInTheDocument();
  });

  it('should show error stack trace', () => {
    render(<ConsoleTab logs={mockLogs} onClear={mockOnClear} />);

    const stackToggle = screen.getByText('Stack trace');
    fireEvent.click(stackToggle);

    expect(screen.getByText(/Error: Test error/)).toBeInTheDocument();
  });

  it('should clear console logs', () => {
    render(<ConsoleTab logs={mockLogs} onClear={mockOnClear} />);

    const clearButton = screen.getByTitle('Clear console');
    fireEvent.click(clearButton);

    expect(mockOnClear).toHaveBeenCalled();
  });

  it('should search logs', () => {
    render(<ConsoleTab logs={mockLogs} onClear={mockOnClear} />);

    const searchInput = screen.getByPlaceholderText('Filter console...');
    fireEvent.change(searchInput, { target: { value: 'error' } });

    // Should show error message
    expect(screen.getByText('Error message')).toBeInTheDocument();
    // Should not show other messages
    expect(screen.queryByText('Test log message')).not.toBeInTheDocument();
  });

  it('should render REPL when onEvaluate is provided', () => {
    render(
      <ConsoleTab
        logs={mockLogs}
        onClear={mockOnClear}
        onEvaluate={mockOnEvaluate}
        previewPort={3000}
      />
    );

    expect(screen.getByPlaceholderText(/Evaluate JavaScript/)).toBeInTheDocument();
    expect(screen.getByText('Run')).toBeInTheDocument();
  });

  it('should evaluate REPL expression on Enter', async () => {
    render(
      <ConsoleTab
        logs={mockLogs}
        onClear={mockOnClear}
        onEvaluate={mockOnEvaluate}
        previewPort={3000}
      />
    );

    const replInput = screen.getByPlaceholderText(/Evaluate JavaScript/);
    fireEvent.change(replInput, { target: { value: '1 + 1' } });
    fireEvent.keyDown(replInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(mockOnEvaluate).toHaveBeenCalledWith('1 + 1');
    });
  });

  it('should navigate REPL history with arrow keys', async () => {
    render(
      <ConsoleTab
        logs={mockLogs}
        onClear={mockOnClear}
        onEvaluate={mockOnEvaluate}
        previewPort={3000}
      />
    );

    const replInput = screen.getByPlaceholderText(/Evaluate JavaScript/);

    // Execute first expression
    fireEvent.change(replInput, { target: { value: 'console.log("test1")' } });
    fireEvent.keyDown(replInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(mockOnEvaluate).toHaveBeenCalledWith('console.log("test1")');
    });

    // Execute second expression
    fireEvent.change(replInput, { target: { value: 'console.log("test2")' } });
    fireEvent.keyDown(replInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(mockOnEvaluate).toHaveBeenCalledWith('console.log("test2")');
    });

    // Navigate up in history
    fireEvent.keyDown(replInput, { key: 'ArrowUp', code: 'ArrowUp' });
    expect(replInput.value).toBe('console.log("test2")');

    fireEvent.keyDown(replInput, { key: 'ArrowUp', code: 'ArrowUp' });
    expect(replInput.value).toBe('console.log("test1")');

    // Navigate down in history
    fireEvent.keyDown(replInput, { key: 'ArrowDown', code: 'ArrowDown' });
    expect(replInput.value).toBe('console.log("test2")');
  });

  it('should parse and display JSON objects', () => {
    const logsWithObject = [
      {
        id: 1,
        level: 'log',
        message: JSON.stringify({ user: 'John', age: 30 }),
        timestamp: Date.now()
      }
    ];

    const { container } = render(<ConsoleTab logs={logsWithObject} onClear={mockOnClear} />);

    const toggle = container.querySelector('.json-toggle');
    fireEvent.click(toggle);

    // Should render as JSON tree
    expect(screen.getByText('user:')).toBeInTheDocument();
    expect(screen.getByText('"John"')).toBeInTheDocument();
  });

  it('should count logs by level', () => {
    render(<ConsoleTab logs={mockLogs} onClear={mockOnClear} />);

    // All logs count
    const allFilter = screen.getByText('All').closest('button');
    expect(allFilter.textContent).toContain('5');

    // Error count
    const errorFilter = screen.getByText('Errors').closest('button');
    expect(errorFilter.textContent).toContain('1');

    // Warning count
    const warnFilter = screen.getByText('Warnings').closest('button');
    expect(warnFilter.textContent).toContain('1');
  });

  it('should handle empty logs', () => {
    render(<ConsoleTab logs={[]} onClear={mockOnClear} />);

    expect(screen.getByText('No console logs')).toBeInTheDocument();
  });

  it('should format timestamps correctly', () => {
    const now = new Date('2024-01-01T12:34:56.789Z');
    const logsWithTime = [
      {
        id: 1,
        level: 'log',
        message: 'Test',
        timestamp: now.getTime()
      }
    ];

    const { container } = render(<ConsoleTab logs={logsWithTime} onClear={mockOnClear} />);
    const timeElement = container.querySelector('.console-timestamp');
    expect(timeElement).toBeInTheDocument();
    expect(timeElement.textContent).toBeTruthy();
  });
});
