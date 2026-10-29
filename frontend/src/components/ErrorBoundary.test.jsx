import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(() => vi.restoreAllMocks());

it('announces a failed view and lets Retry recover without showing internal errors', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let fails = true;
  function View() { if (fails) throw new Error('synthetic internal diagnostic'); return <p>Terminal ready</p>; }
  render(<ErrorBoundary name="terminal"><View /></ErrorBoundary>);
  expect(screen.getByRole('alert')).toHaveTextContent('Unable to display terminal');
  expect(screen.queryByText('synthetic internal diagnostic')).not.toBeInTheDocument();
  fails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  expect(screen.getByText('Terminal ready')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
