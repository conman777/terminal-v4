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
