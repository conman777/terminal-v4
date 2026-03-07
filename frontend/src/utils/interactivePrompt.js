function buildAction(label, payload, kind = 'secondary') {
  return { label, payload, kind };
}

export function parseInteractivePromptSnapshot(snapshotText) {
  if (typeof snapshotText !== 'string') return null;
  const text = snapshotText.trim();
  if (!text) return null;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const lowerText = text.toLowerCase();
  const numberedOptions = lines
    .map((line, index) => {
      const match = line.match(/^([›>]\s*)?(\d+)\.\s+(.+)$/);
      if (!match) return null;
      return {
        index,
        isSelected: Boolean(match[1]),
        label: `${match[2]}. ${match[3].trim()}`
      };
    })
    .filter(Boolean);
  const promptLine = lines.find((line) => (
    /update available/i.test(line)
    || /\[[yYnN]\/[yYnN]\]/.test(line)
    || /(?:continue anyway|trust this folder|select an option|confirm|cancel)/i.test(line)
    || /(?:press enter to continue|enter|esc|shift\+tab|tab to cycle)/i.test(line)
  )) || lines[0];

  const actions = [];
  if (numberedOptions.length > 0) {
    const selectedIndex = numberedOptions.findIndex((option) => option.isSelected);
    const baseIndex = selectedIndex >= 0 ? selectedIndex : 0;
    for (let index = 0; index < numberedOptions.length; index += 1) {
      const option = numberedOptions[index];
      const delta = index - baseIndex;
      const navigation = delta > 0
        ? '\x1b[B'.repeat(delta)
        : '\x1b[A'.repeat(Math.abs(delta));
      actions.push(buildAction(
        option.label,
        `${navigation}\r`,
        option.isSelected || (selectedIndex === -1 && index === 0) ? 'primary' : 'secondary'
      ));
    }
  }

  if (/\[[yYnN]\/[yYnN]\]/.test(promptLine) || /continue anyway|trust this folder/i.test(promptLine)) {
    actions.push(
      buildAction('Yes', 'y\r', 'primary'),
      buildAction('No', 'n\r', 'secondary')
    );
  }

  if (/enter to (confirm|continue)|press enter to continue|\[[yYnN]\/[yYnN]\]|continue anyway|confirm/i.test(promptLine) || /enter to (confirm|continue)|press enter to continue/i.test(lowerText)) {
    actions.push(buildAction('Enter', '\r', 'secondary'));
  }

  if (/esc(?:ape)? to cancel|cancel/i.test(promptLine) || /esc(?:ape)? to cancel/i.test(lowerText)) {
    actions.push(buildAction('Esc', '\x1b', 'secondary'));
  }

  if (/shift\+tab to cycle|tab to cycle/i.test(promptLine) || /shift\+tab to cycle|tab to cycle/i.test(lowerText)) {
    actions.push(
      buildAction('Tab', '\t', 'secondary'),
      buildAction('Shift+Tab', '\x1b[Z', 'secondary')
    );
  }

  if (actions.length === 0) return null;

  const seen = new Set();
  const deduped = actions.filter((action) => {
    const key = `${action.label}:${action.payload}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    prompt: promptLine,
    actions: deduped
  };
}

export function parseInteractivePromptEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'prompt_required') return null;
  if (typeof event.prompt !== 'string' || event.prompt.trim().length === 0) return null;

  if (Array.isArray(event.options) && event.options.length > 0) {
    const actions = event.options
      .filter((option) => option && typeof option === 'object')
      .map((option) => ({
        label: typeof option.label === 'string' ? option.label.trim() : '',
        payload: typeof option.payload === 'string' ? option.payload : '',
        kind: option.kind === 'primary' ? 'primary' : 'secondary'
      }))
      .filter((option) => option.label && option.payload);

    if (actions.length > 0) {
      return {
        prompt: event.prompt.trim(),
        actions
      };
    }
  }

  const actionMap = {
    yes: buildAction('Yes', 'y\r', 'primary'),
    no: buildAction('No', 'n\r', 'secondary'),
    enter: buildAction('Enter', '\r', 'secondary'),
    escape: buildAction('Esc', '\x1b', 'secondary'),
    tab: buildAction('Tab', '\t', 'secondary'),
    shift_tab: buildAction('Shift+Tab', '\x1b[Z', 'secondary')
  };

  const requestedActions = Array.isArray(event.actions)
    ? event.actions.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];
  const mapped = requestedActions.map((name) => actionMap[name]).filter(Boolean);
  const actions = mapped.length > 0 ? mapped : [buildAction('Enter', '\r', 'secondary')];

  return {
    prompt: event.prompt.trim(),
    actions
  };
}
