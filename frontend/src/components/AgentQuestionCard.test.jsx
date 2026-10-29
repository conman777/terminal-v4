import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentQuestionCard } from './AgentQuestionCard';

const questions = [
  { id: 'colour', header: 'Theme', question: 'Which accent colour?', options: [{ label: 'Indigo', description: 'Matches T3' }, { label: 'Amber' }] },
  { id: 'name', header: 'Name', question: 'What should the project be called?' },
];

describe('AgentQuestionCard', () => {
  it('sends one answer per question once every question is answered', () => {
    const onAnswer = vi.fn();
    render(<AgentQuestionCard questions={questions} onAnswer={onAnswer} onDismiss={vi.fn()} />);
    const send = screen.getByRole('button', { name: 'Send answers' });
    fireEvent.click(screen.getByRole('radio', { name: /Indigo/ }));
    const blockedUntilEveryAnswer = send.disabled;
    fireEvent.change(screen.getByRole('textbox', { name: 'What should the project be called?' }), { target: { value: '  Terminal v4  ' } });
    fireEvent.click(send);
    expect([blockedUntilEveryAnswer, onAnswer.mock.calls]).toEqual([true, [[{ colour: ['Indigo'], name: ['Terminal v4'] }]]]);
  });

  it('lets an option question be answered in the user\'s own words, or dismissed', () => {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    render(<AgentQuestionCard questions={questions.slice(0, 1)} onAnswer={onAnswer} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer to: Which accent colour?' }), { target: { value: 'Teal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss question' }));
    expect([onAnswer.mock.calls, onDismiss.mock.calls.length]).toEqual([[[{ colour: ['Teal'] }]], 1]);
  });
});

describe('AgentQuestionCard keyboard and counter', () => {
  const batch = [
    { id: 'a', question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] },
    { id: 'b', question: 'Second?', options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }] },
    { id: 'c', question: 'Third?' },
  ];

  it('shows N/M counters only for multi-question batches', () => {
    const { rerender } = render(<AgentQuestionCard questions={batch} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getAllByLabelText(/^Question \d of 3$/).map(node => node.textContent)).toEqual(['1/3', '2/3', '3/3']);
    rerender(<AgentQuestionCard questions={batch.slice(0, 1)} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.queryByLabelText(/^Question \d of/)).toBeNull();
  });

  it('answers the first unanswered option question with number keys and moves on', () => {
    const onAnswer = vi.fn();
    render(<AgentQuestionCard questions={batch} onAnswer={onAnswer} onDismiss={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: '2' });
    fireEvent.keyDown(document.body, { key: '3' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Third?' }), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    expect(onAnswer.mock.calls).toEqual([[{ a: ['No'], b: ['Green'], c: ['ok'] }]]);
  });

  it('maps the number after the last option to Something else and focuses its text box', async () => {
    render(<AgentQuestionCard questions={batch.slice(0, 1)} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: '3' });
    const field = screen.getByRole('textbox', { name: 'Your answer to: First?' });
    await vi.waitFor(() => expect(field).toHaveFocus());
  });

  it('ignores digits typed into a text field, modifiers, out-of-range keys and a disabled card', () => {
    const { rerender } = render(<AgentQuestionCard questions={batch} onAnswer={vi.fn()} onDismiss={vi.fn()} />);
    const text = screen.getByRole('textbox', { name: 'Third?' });
    fireEvent.keyDown(text, { key: '1' });
    fireEvent.keyDown(document.body, { key: '1', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: '9' });
    expect(screen.getAllByRole('radio').filter(radio => radio.checked)).toEqual([]);
    rerender(<AgentQuestionCard questions={batch} onAnswer={vi.fn()} onDismiss={vi.fn()} disabled />);
    fireEvent.keyDown(document.body, { key: '1' });
    expect(screen.getAllByRole('radio').filter(radio => radio.checked)).toEqual([]);
  });

  it('never submits on Enter or digits alone', () => {
    const onAnswer = vi.fn();
    render(<AgentQuestionCard questions={batch.slice(0, 1)} onAnswer={onAnswer} onDismiss={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
