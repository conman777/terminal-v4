import { useEffect, useId, useRef, useState } from 'react';
import './AgentQuestionCard.css';

const OTHER = '\u0000other';

function answerFor(question, choice, text) {
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length && choice !== OTHER) return choice ? [choice] : [];
  const typed = (text || '').trim();
  return typed ? [typed] : [];
}

// An agent's multiple-choice or free-text question, answered inline like T3 Code's question cards.
export function AgentQuestionCard({ questions, onAnswer, onDismiss, disabled = false }) {
  const id = useId();
  const [choices, setChoices] = useState({});
  const [texts, setTexts] = useState({});
  const answers = Object.fromEntries(questions.map(question => [question.id, answerFor(question, choices[question.id], texts[question.id])]));
  const complete = questions.every(question => answers[question.id].length > 0);
  const root = useRef(null);
  const live = useRef({});
  live.current = { questions, answers, disabled };
  const activeId = questions.find(question => Array.isArray(question.options) && question.options.length && answers[question.id].length === 0)?.id;

  useEffect(() => {
    function handleKey(event) {
      const { questions: items, answers: current, disabled: locked } = live.current;
      if (locked || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)
        || (target.tagName === 'INPUT' && !['radio', 'checkbox', 'button'].includes(target.type)))) return;
      const question = items.find(item => Array.isArray(item.options) && item.options.length && (current[item.id] || []).length === 0);
      if (!question) return;
      const choices = [...question.options.map(option => option.value ?? option.label), OTHER];
      const choice = choices[Number(event.key) - 1];
      if (choice === undefined) return;
      event.preventDefault();
      setChoices(previous => ({ ...previous, [question.id]: choice }));
      if (choice === OTHER) setTimeout(() => root.current?.querySelector(`textarea[data-question="${CSS.escape(String(question.id))}"]`)?.focus(), 0);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="agent-question-card" role="group" aria-label="Agent question" ref={root}>
      {questions.map((question, index) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const freeText = !options.length || choices[question.id] === OTHER;
        return (
          <fieldset key={question.id} className="agent-question">
            <legend>
              {questions.length > 1 && <span className="agent-question-counter" aria-label={`Question ${index + 1} of ${questions.length}`}>{index + 1}/{questions.length}</span>}
              {question.header && <span className="agent-question-header">{question.header}</span>}
              <span className="agent-question-text">{question.question}</span>
            </legend>
            {options.length > 0 && <div className="agent-question-options">
              {[...options, { label: 'Something else', value: OTHER }].map((option, optionIndex) => {
                const value = option.value ?? option.label;
                return (
                  <label key={value} className={`agent-question-option${choices[question.id] === value ? ' selected' : ''}`}>
                    <input type="radio" name={`${id}-${index}`} value={value} checked={choices[question.id] === value} disabled={disabled}
                      onChange={() => setChoices(current => ({ ...current, [question.id]: value }))} />
                    {optionIndex < 9 && <kbd className={`agent-question-key${question.id === activeId ? ' active' : ''}`} aria-hidden="true">{optionIndex + 1}</kbd>}
                    <span>{option.label}{option.description && <small>{option.description}</small>}</span>
                  </label>
                );
              })}
            </div>}
            {freeText && <textarea rows={2} maxLength={4000} disabled={disabled} value={texts[question.id] || ''}
              aria-label={options.length ? `Your answer to: ${question.question}` : question.question}
              placeholder="Type your answer" data-question={question.id}
              onChange={event => setTexts(current => ({ ...current, [question.id]: event.target.value }))} />}
          </fieldset>
        );
      })}
      <div className="agent-question-actions">
        <button type="button" className="agent-question-dismiss" onClick={onDismiss} disabled={disabled}>Dismiss question</button>
        <button type="button" className="agent-question-send" onClick={() => onAnswer(answers)} disabled={disabled || !complete}>Send answers</button>
      </div>
    </div>
  );
}
