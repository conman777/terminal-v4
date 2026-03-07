import { parseInteractivePromptEvent, parseInteractivePromptSnapshot } from '../utils/interactivePrompt';

export function CliActivityStrip({
  interactivePromptEvent = null,
  terminalScreenSnapshot = '',
  onSendRaw
}) {
  const promptState = parseInteractivePromptEvent(interactivePromptEvent)
    || parseInteractivePromptSnapshot(terminalScreenSnapshot);

  if (!promptState) {
    return null;
  }

  return (
    <div className="cli-activity-strip">
      {promptState && (
        <section className="cli-activity-card cli-activity-prompt-card" aria-label="Interactive prompt">
          <div className="cli-activity-card-header">
            <span className="cli-activity-eyebrow">Needs input</span>
            <span className="cli-activity-card-title">{promptState.prompt}</span>
          </div>
          <div className="cli-activity-actions">
            {promptState.actions.map((action) => (
              <button
                key={`${action.label}:${action.payload}`}
                type="button"
                className={`cli-activity-action ${action.kind === 'primary' ? 'primary' : 'secondary'}`}
                onClick={() => onSendRaw?.(action.payload)}
              >
                {action.label}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
