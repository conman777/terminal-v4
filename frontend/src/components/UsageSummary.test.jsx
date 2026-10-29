import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { apiGet } from '../utils/api';
import { UsageSummary } from './UsageSummary';

vi.mock('../utils/api', () => ({ apiGet: vi.fn() }));

describe('UsageSummary', () => {
  it('totals tokens and cost across threads, and for the last 7 days', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    vi.mocked(apiGet).mockResolvedValue({ threads: [
      { id: 'a', title: 'Recent', provider: 'claude', updatedAt: '2026-10-25T10:00:00Z', inputTokens: 1000, outputTokens: 100, costUsd: 0.5 },
      { id: 'b', title: 'Old', provider: 'codex', updatedAt: '2026-09-01T10:00:00Z', inputTokens: 3000, outputTokens: 300, costUsd: null },
    ] });
    render(<UsageSummary now={now} />);
    expect((await screen.findByText('Last 7 days')).closest('div').textContent).toContain('1,100 tokens · $0.50');
    expect([screen.getByText('All time').closest('div').textContent.includes('4,400 tokens · $0.50'), screen.getAllByRole('row').length]).toEqual([true, 3]);
  });
});
