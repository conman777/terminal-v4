import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHistoryModal } from './TerminalHistoryModal';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../utils/api', () => ({ apiGet }));
vi.mock('../hooks/useMobileDetect', () => ({ useMobileDetect: () => false }));

describe('TerminalHistoryModal', () => {
  beforeEach(() => { apiGet.mockReset(); });

  it('renders synthetic terminal history as normalized read-only code', async () => {
    apiGet.mockResolvedValue({ history: [{ text: '\u001b[32mfirst\u001b[0m\r\n' }, { text: 'second\rthird' }] });
    render(<TerminalHistoryModal isOpen sessionId="fixture-session" onClose={vi.fn()} />);
    expect(await screen.findByRole('textbox', { name: 'Terminal history' })).toHaveValue('first\nsecond\nthird');
    expect(screen.getByRole('textbox', { name: 'Terminal history' })).toHaveAttribute('readonly');
    expect(apiGet).toHaveBeenCalledExactlyOnceWith('/api/terminal/fixture-session/history?historyChars=5000000');
  });

  it('announces history failures without displaying stale content', async () => {
    apiGet.mockRejectedValue(new Error('Synthetic history unavailable'));
    render(<TerminalHistoryModal isOpen sessionId="fixture-session" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic history unavailable');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
