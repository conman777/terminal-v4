import { useId, useState } from 'react';
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

  return (
    <div className="agent-question-card" role="group" aria-label="Agent question">
      {questions.map((question, index) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const freeText = !options.length || choices[question.id] === OTHER;
        return (
          <fieldset key={question.id} className="agent-question">
            <legend>
              {question.header && <span className="agent-question-header">{question.header}</span>}
              <span className="agent-question-text">{question.question}</span>
            </legend>
            {options.length > 0 && <div className="agent-question-options">
              {[...options, { label: 'Something else', value: OTHER }].map(option => {
                const value = option.value ?? option.label;
                return (
                  <label key={value} className={`agent-question-option${choices[question.id] === value ? ' selected' : ''}`}>
                    <input type="radio" name={`${id}-${index}`} value={value} checked={choices[question.id] === value} disabled={disabled}
                      onChange={() => setChoices(current => ({ ...current, [question.id]: value }))} />
                    <span>{option.label}{option.description && <small>{option.description}</small>}</span>
                  </label>
                );
              })}
            </div>}
            {freeText && <textarea rows={2} maxLength={4000} disabled={disabled} value={texts[question.id] || ''}
              aria-label={options.length ? `Your answer to: ${question.question}` : question.question}
              placeholder="Type your answer"
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
