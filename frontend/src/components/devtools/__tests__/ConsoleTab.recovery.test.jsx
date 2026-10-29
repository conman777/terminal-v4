import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleTab } from '../ConsoleTab';

const input = () => screen.getByPlaceholderText(/Evaluate JavaScript/);
const type = value => fireEvent.change(input(), { target: { value } });
const enter = extra => fireEvent.keyDown(input(), { key: 'Enter', ...extra });

describe('ConsoleTab draft recovery', () => {
  it('restores an unsent draft after navigating through evaluation history', async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    render(<ConsoleTab onEvaluate={evaluate} previewPort={4173} />);
    type('1 + 1');
    enter();
    await waitFor(() => expect(evaluate).toHaveBeenCalledWith('1 + 1'));
    type('unfinished draft');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input()).toHaveValue('1 + 1');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input()).toHaveValue('unfinished draft');
  });

  it('does not evaluate an IME composition confirmation', () => {
    const evaluate = vi.fn();
    render(<ConsoleTab onEvaluate={evaluate} previewPort={4173} />);
    type('composing');
    enter({ isComposing: true, keyCode: 229 });
    expect(evaluate).not.toHaveBeenCalled();
    expect(input()).toHaveValue('composing');
  });

  it('shows a failure, restores the failed draft and permits retry', async () => {
    const evaluate = vi.fn().mockRejectedValueOnce(new Error('Synthetic offline')).mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ConsoleTab onEvaluate={evaluate} previewPort={4173} />);
    type('retry expression');
    enter();
    expect(await screen.findByRole('alert')).toHaveTextContent('Evaluation failed');
    expect(input()).toHaveValue('retry expression');
    enter();
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('keeps a newer draft when an older evaluation fails', async () => {
    let reject;
    const evaluate = vi.fn(() => new Promise((_resolve, no) => { reject = no; }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ConsoleTab onEvaluate={evaluate} previewPort={4173} />);
    type('old expression');
    enter();
    type('newer draft');
    await act(async () => reject(new Error('Synthetic offline')));
    expect(input()).toHaveValue('newer draft');
    expect(screen.getByRole('alert')).toHaveTextContent('Evaluation failed');
    vi.restoreAllMocks();
  });
});
