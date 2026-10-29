import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkTab } from '../NetworkTab';

const requests = [
  { method: 'GET', url: '/app.js?v=fixture', status: 404, contentType: 'text/html', timestamp: 1000 },
  { method: 'GET', url: '/app.css?v=fixture', status: 200, contentType: '', timestamp: 2000 },
  { method: 'GET', url: '/api/data', status: 200, contentType: 'application/json', timestamp: 3000 },
];
afterEach(() => { vi.restoreAllMocks(); });

describe('NetworkTab usable inspection', () => {
  it('counts and filters query-string assets consistently without also including them in Other', () => {
    render(<NetworkTab requests={requests} />);
    expect(screen.getByText('JS').closest('button')).toHaveTextContent('JS1');
    expect(screen.getByText('CSS').closest('button')).toHaveTextContent('CSS1');
    expect(screen.getByText('Other').closest('button')).toHaveTextContent('Other0');
    fireEvent.click(screen.getByText('JS'));
    expect(screen.getByText('/app.js?v=fixture')).toBeInTheDocument();
    expect(screen.queryByText('/app.css?v=fixture')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Other'));
    expect(screen.getByText('No requests match filters')).toBeInTheDocument();
  });

  it('opens a request with the keyboard and dismisses stale details when logs are cleared', async () => {
    const user = userEvent.setup();
    const view = render(<NetworkTab requests={requests} />);
    const request = screen.getByRole('button', { name: /Inspect GET \/app.js/ });
    request.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Request Headers')).toBeInTheDocument();
    view.rerender(<NetworkTab requests={[]} />);
    expect(screen.queryByText('Request Headers')).not.toBeInTheDocument();
  });

  it('keeps inspection open when polling supplies a fresh object for the selected request', () => {
    const view = render(<NetworkTab requests={requests} />);
    fireEvent.click(screen.getByText('/app.js?v=fixture').closest('tr'));
    view.rerender(<NetworkTab requests={requests.map(request => ({ ...request, responseHeaders: { 'X-Fixture': 'fresh response' } }))} />);
    expect(screen.getByText('Request Headers')).toBeInTheDocument();
    expect(screen.getByText('fresh response')).toBeInTheDocument();
  });

  it.each(['cURL', 'fetch', 'Axios'])('reports rejected clipboard access for Copy as %s', async format => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Synthetic denied')) } });
    render(<NetworkTab requests={requests} />);
    fireEvent.click(screen.getByText('/app.js?v=fixture').closest('tr'));
    fireEvent.click(screen.getByTitle(`Copy as ${format}`));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);
  });
});
