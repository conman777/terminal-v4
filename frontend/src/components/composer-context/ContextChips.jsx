const KIND_LABEL = { terminal: 'Terminal', thread: 'Thread', pr: 'Pull request' };

export function ContextChips({ chips, unavailable = () => false, onRemove }) {
  if (!chips.length) return null;
  return (
    <ul className="composer-context-chips" aria-label="Attached context">
      {chips.map((chip, index) => {
        const missing = unavailable(chip);
        return (
          <li key={`${chip.kind}-${chip.id || index}`} className={`composer-context-chip${missing ? ' unavailable' : ''}`} data-kind={chip.kind}
            title={chip.kind === 'terminal' ? chip.body.slice(0, 400) : chip.label}>
            <span className="composer-context-chip-kind">{KIND_LABEL[chip.kind]}</span>
            <span className="composer-context-chip-label">{chip.label}</span>
            {missing && <span className="composer-context-chip-warning" role="status">Unavailable</span>}
            <button type="button" aria-label={`Remove ${KIND_LABEL[chip.kind].toLowerCase()} context: ${chip.label}`} onClick={() => onRemove(index)}>×</button>
          </li>
        );
      })}
    </ul>
  );
}
