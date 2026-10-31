import { useEffect, useId, useRef, useState } from 'react';
import './AgentQuestionCard.css';

const OTHER = '\u0000other';
const ownValue = (record, key) => Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

function answerFor(question, choice, text) {
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length && question.multiSelect === true) {
    const selected = Array.isArray(choice) ? choice : [];
    const typed = typeof text === 'string' ? text.trim() : '';
    if (selected.includes(OTHER) && (!typed || selected.includes(typed))) return [];
    return selected.map(value => value === OTHER ? typed : value);
  }
  if (options.length && choice !== OTHER) return choice ? [choice] : [];
  const typed = typeof text === 'string' ? text.trim() : '';
  return typed ? [typed] : [];
}

// An agent's multiple-choice or free-text question, answered inline like T3 Code's question cards.
export function AgentQuestionCard({ questions, onAnswer, onDismiss, disabled = false }) {
  const id = useId();
  const [choices, setChoices] = useState({});
  const [texts, setTexts] = useState({});
  const [focusedMulti, setFocusedMulti] = useState(null);
  const answers = Object.fromEntries(questions.map(question => [question.id, answerFor(question, ownValue(choices, question.id), ownValue(texts, question.id))]));
  const complete = questions.every(question => answers[question.id].length > 0);
  const root = useRef(null);
  const live = useRef({});
  const activeId = questions.find(question => question.id === focusedMulti && question.multiSelect === true)?.id
    || questions.find(question => Array.isArray(question.options) && question.options.length && answers[question.id].length === 0)?.id;
  live.current = { questions, answers, disabled, activeId };

  useEffect(() => {
    function handleKey(event) {
      const { questions: items, disabled: locked, activeId: active } = live.current;
      if (locked || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['TEXTAREA', 'SELECT'].includes(target.tagName)
        || (target.tagName === 'INPUT' && !['radio', 'checkbox', 'button'].includes(target.type)))) return;
      const question = items.find(item => item.id === active && Array.isArray(item.options) && item.options.length);
      if (!question) return;
      const choices = [...question.options.map(option => option.value ?? option.label), OTHER];
      const choice = choices[Number(event.key) - 1];
      if (choice === undefined) return;
      event.preventDefault();
      setChoices(previous => {
        if (question.multiSelect !== true) return { ...previous, [question.id]: choice };
        const selected = Array.isArray(ownValue(previous, question.id)) ? ownValue(previous, question.id) : [];
        return { ...previous, [question.id]: selected.includes(choice) ? selected.filter(value => value !== choice) : [...selected, choice] };
      });
      if (choice === OTHER) setTimeout(() => root.current?.querySelector(`textarea[data-question="${CSS.escape(String(question.id))}"]`)?.focus(), 0);
      else if (question.multiSelect === true) setTimeout(() => {
        const fieldset = [...(root.current?.querySelectorAll('fieldset[data-question-id]') || [])].find(element => element.dataset.questionId === String(question.id));
        fieldset?.querySelectorAll('input')[Number(event.key) - 1]?.focus();
      }, 0);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <div className="agent-question-card" role="group" aria-label="Agent question" ref={root}>
      {questions.map((question, index) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const multi = options.length > 0 && question.multiSelect === true;
        const choice = ownValue(choices, question.id);
        const text = ownValue(texts, question.id) || '';
        const selected = multi && Array.isArray(choice) ? choice : [];
        const freeText = !options.length || (multi ? selected.includes(OTHER) : choice === OTHER);
        const duplicateOther = multi && selected.includes(OTHER) && Boolean(text.trim()) && selected.includes(text.trim());
        return (
          <fieldset key={question.id} className="agent-question" data-question-id={question.id}
            onFocusCapture={() => { if (multi) setFocusedMulti(question.id); }}
            onBlurCapture={event => { if (multi && !event.currentTarget.contains(event.relatedTarget)) setFocusedMulti(null); }}>
            <legend>
              {questions.length > 1 && <span className="agent-question-counter" aria-label={`Question ${index + 1} of ${questions.length}`}>{index + 1}/{questions.length}</span>}
              {question.header && <span className="agent-question-header">{question.header}</span>}
              <span className="agent-question-text">{question.question}</span>
            </legend>
            {multi && <p className="agent-question-hint">Select all that apply.</p>}
            {options.length > 0 && <div className="agent-question-options">
              {[...options, { label: 'Something else', value: OTHER }].map((option, optionIndex) => {
                const value = option.value ?? option.label;
                return (
                  <label key={value} className={`agent-question-option${(multi ? selected.includes(value) : choice === value) ? ' selected' : ''}`}>
                    <input type={multi ? 'checkbox' : 'radio'} name={`${id}-${index}`} value={value} checked={multi ? selected.includes(value) : choice === value} disabled={disabled}
                      onChange={() => setChoices(current => {
                        if (!multi) return { ...current, [question.id]: value };
                        const existing = Array.isArray(ownValue(current, question.id)) ? ownValue(current, question.id) : [];
                        return { ...current, [question.id]: existing.includes(value) ? existing.filter(item => item !== value) : [...existing, value] };
                      })} />
                    {optionIndex < 9 && <kbd className={`agent-question-key${question.id === activeId ? ' active' : ''}`} aria-hidden="true">{optionIndex + 1}</kbd>}
                    <span>{option.label}{option.description && <small>{option.description}</small>}</span>
                  </label>
                );
              })}
            </div>}
            {freeText && <textarea rows={2} maxLength={4000} disabled={disabled} value={text}
              aria-label={options.length ? `Your answer to: ${question.question}` : question.question} aria-invalid={duplicateOther || undefined} aria-describedby={duplicateOther ? `${id}-${index}-duplicate` : undefined}
              placeholder="Type your answer" data-question={question.id}
              onChange={event => setTexts(current => ({ ...current, [question.id]: event.target.value }))} />}
            {duplicateOther && <p id={`${id}-${index}-duplicate`} className="agent-question-error" role="alert">Choose a different custom answer or deselect the duplicate choice.</p>}
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
